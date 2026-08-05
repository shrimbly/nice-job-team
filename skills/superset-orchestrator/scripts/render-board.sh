#!/usr/bin/env bash
# Render the board as a local dashboard: one horizontal card per task/PR, compact,
# with links out to the PR, its ticket, and its Vercel preview. A chevron expands
# each card to a two-line "what it is / where it's at".
#
#   render-board.sh              # regenerate ~/.claude/superset-orchestrator/board.html
#   render-board.sh --open       # ...and open it
#   render-board.sh --poll       # run poll.sh first, so the data is fresh
#   render-board.sh --watch [n]  # regenerate every n seconds (default 90) until killed
#
# Reads board.json, signals/github.json and workspaces/*.json. Writes only board.html.

. "$(cd "$(dirname "$0")" && pwd)/lib.sh"

OUT="$BOARD_DIR/board.html"
do_open=0; do_poll=0; watch=0; interval=90
while [ $# -gt 0 ]; do
  case "$1" in
    --open)  do_open=1; shift ;;
    --poll)  do_poll=1; shift ;;
    --watch) watch=1; [ "${2-}" ] && [ -z "${2##[0-9]*}" ] && { interval="$2"; shift; }; shift ;;
    *) die "unknown argument: $1" ;;
  esac
done

render() {
  [ "$do_poll" = 1 ] && "$SKILL_DIR/scripts/poll.sh" >/dev/null 2>&1

  local status_json='[]'
  if ls "$WORKSPACES_DIR"/*.json >/dev/null 2>&1; then
    status_json="$(jq -s '.' "$WORKSPACES_DIR"/*.json)"
  fi
  local gh_json='{}'
  [ -f "$BOARD_DIR/signals/github.json" ] && gh_json="$(cat "$BOARD_DIR/signals/github.json")"
  local ws_json='[]'
  [ -f "$BOARD_DIR/signals/workspaces.json" ] && \
    ws_json="$(jq -c '.workspaces // []' "$BOARD_DIR/signals/workspaces.json")"
  local linear_ws; linear_ws="$(cfg '.operator.linearWorkspace' acme)"

  local payload
  payload="$(jq -n \
    --slurpfile board "$BOARD" \
    --argjson gh "$gh_json" \
    --argjson status "$status_json" \
    --argjson ws "$ws_json" \
    --arg linearWs "$linear_ws" \
    --arg generatedAt "$(now)" '
    ( [ ($gh.repos // [])[] | (.open // [])[] ] | INDEX(.number | tostring) ) as $prs
    | ( $status | INDEX(.workspaceId) ) as $st
    | ( $ws | INDEX(.id) ) as $wsById
    | {
        generatedAt: $generatedAt,
        cards: [ ($board[0].items // [])[]
          | select(.state | IN("closed","rejected") | not)   # merged stays visible until its workspace is reaped
          | . as $it
          | ($prs[($it.pr.number // 0 | tostring)] // {}) as $p
          | ($st[($it.workspaceId // "")] // null) as $a
          | ($a.needsOperator // false) as $needs
          | {
              id: $it.id,
              num: ($it.pr.number // null),
              title: $it.title,
              branch: ($it.branch // $p.headRefName // ""),
              # Which Superset workspace holds this work — the operator instructs the
              # agent in that chat, so the name and a deep link to it are navigation.
              workspace: ($wsById[($it.workspaceId // "")].name // null),
              workspaceId: ($it.workspaceId // null),
              workspaceUrl: (if ($it.workspaceId // null) != null
                             then "superset://v2-workspace/" + $it.workspaceId else null end),
              boardState: $it.state,
              prUrl: ($it.pr.url // $p.url // null),
              ticketKey: (if ($it.source.kind == "linear") then $it.source.externalId else null end),
              ticketUrl: (if ($it.source.kind == "linear")
                          then "https://linear.app/" + $linearWs + "/issue/" + $it.source.externalId
                          else null end),
              previewUrl: ($p.previewUrl // null),
              review: ($p.reviewDecision // $it.pr.reviewDecision // null),
              ci: ($p.ciState // $it.pr.ciState // "unknown"),
              threads: ($p.unresolvedThreads // 0),
              draft: ($p.isDraft // $it.pr.isDraft // false),
              mergeState: ($p.mergeStateStatus // $it.pr.mergeStateStatus // null),
              needsOperator: $needs,
              agentState: ($a.state // null),
              agentPhase: ($a.phase // null),
              agentSummary: ($a.summary // null),
              liveness: ($a.sessionLiveness // null),
              dirty: ($a.dirtyFiles // null),
              unpushed: ($a.unpushedCommits // null),
              whatItIs: (if ($it.outcome // "") != "" then $it.outcome else $it.title end),
              pill: (
                # Ready outranks everything except a blocked agent: it is the only
                # row where the next move is yours and takes one click.
                if $needs and ($a.state == "blocked") then {label:"Blocked", tone:"you"}
                elif ($it.state == "ready") then {label:"★ Ready to merge", tone:"good"}
                elif $needs then {label:"Needs you", tone:"you"}
                # Read the ITEM state, never the agent status file directly. sync.sh
                # has already reconciled that file against the live PR — an agent
                # writes "fixing" when it starts and routinely never writes again, so
                # trusting $a.state here re-introduced the exact staleness sync exists
                # to remove: a rebased, green, review-ready PR rendered as "Fixing".
                elif ($it.state == "building") then {label:"Working", tone:"agent"}
                # Was labelled "Dispatched", which is a different state entirely — a
                # PR in review round 2 read as though it had never been started.
                elif ($it.state == "fixing") then {label:"Fixing", tone:"agent"}
                elif ($p.isDraft // false) then {label:"Draft", tone:"mute"}
                elif ($p.reviewDecision == "APPROVED" and ($p.ciState == "red")) then {label:"CI red", tone:"bad"}
                elif ($p.reviewDecision == "APPROVED" and ($p.mergeStateStatus == "DIRTY")) then {label:"Conflicts", tone:"bad"}
                elif ($p.reviewDecision == "APPROVED") then {label:"Mergeable", tone:"good"}
                elif ($p.reviewDecision == "CHANGES_REQUESTED") then {label:"Changes req", tone:"bad"}
                elif ($p.reviewDecision == "REVIEW_REQUIRED") then {label:"In review", tone:"review"}
                elif ($p != {}) then {label:"No reviewer", tone:"you"}
                # No live PR row: either it landed, or there is no PR at all yet.
                elif ($it.state == "merged") then {label:"Merged — reap", tone:"good"}
                elif (($it.pr.number // null) != null) then {label:"Gone from open", tone:"mute"}
                elif ($it.state == "dispatched") then {label:"Starting", tone:"agent"}
                elif ($it.state == "building") then {label:"Working", tone:"agent"}
                else {label:$it.state, tone:"mute"} end),
              whereItsAt: (
                # At the gate the phase ("self-review complete") says nothing useful,
                # so prefer the first line of the summary the agent wrote.
                if ($a.state == "awaiting-approval" and ($a.summary // null) != null)
                  then ($a.summary | split("\n")[0])
                # When the agent state disagrees with the reconciled item state, the
                # phase describes work that already finished ("rebasing #477..." beside
                # a green, review-ready PR). Label it rather than let it read as live.
                # NB: no apostrophes in these comments — this jq program sits inside a
                # single-quoted bash string, and one closes it.
                elif ($a.state != null) and ($a.state != $it.state) and (($a.phase // null) != null)
                  then "last agent update: \($a.phase)"
                elif ($a.phase // null) != null then $a.phase
                elif ($a.summary // null) != null then $a.summary
                elif ($p.isDraft // false) then "Open as a draft — reviewers skip drafts until it is marked ready."
                elif ($p.reviewDecision == "APPROVED" and $p.ciState == "red") then "Approved. Only the failing check is holding it."
                elif ($p.reviewDecision == "APPROVED" and $p.mergeStateStatus == "DIRTY") then "Approved, but the branch conflicts with main."
                elif ($p.reviewDecision == "APPROVED") then "Approved and clean — ready for you to merge."
                elif ($p.reviewDecision == "REVIEW_REQUIRED") then "Waiting on a reviewer."
                elif ($p != {}) then "Open, green, and nobody has been asked to review it."
                else "No PR data in the last poll." end)
            } ]
        | sort_by(
            (if .pill.tone == "you" then 0
             elif .pill.tone == "bad" then 1
             elif .pill.tone == "agent" then 2
             elif .pill.tone == "good" then 3
             elif .pill.tone == "review" then 4
             else 5 end),
            (0 - (.num // 0)))
      }')"

  {
    cat <<'HTML_HEAD'
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Board</title>
<style>
:root{
  --bg:#F2F4F7; --card:#FFFFFF; --ink:#12161B; --soft:#5A646F; --faint:#8A939E;
  --rule:#E1E6EB; --rule2:#CDD5DD;
  --you:#A9670F; --you-bg:#FBF0DE;
  --agent:#2C5E93; --agent-bg:#E5EDF6;
  --bad:#9C3236; --bad-bg:#FAE7E7;
  --good:#256B4C; --good-bg:#E2F1EA;
  --review:#5A646F; --review-bg:#EDF0F3;
  --mute:#78828D; --mute-bg:#EDF0F3;
  --sans:-apple-system,system-ui,"SF Pro Text",sans-serif;
  --mono:ui-monospace,"SF Mono",Menlo,monospace;
}
@media (prefers-color-scheme:dark){
  :root{
    --bg:#0E1216; --card:#171C22; --ink:#E7EBF0; --soft:#A0AAB5; --faint:#6F7A85;
    --rule:#242B33; --rule2:#333C46;
    --you:#E0A756; --you-bg:#2A2114;
    --agent:#84B0DD; --agent-bg:#16222E;
    --bad:#E08A8E; --bad-bg:#2B1719;
    --good:#72C09A; --good-bg:#12241C;
    --review:#A0AAB5; --review-bg:#1E242B;
    --mute:#7E8892; --mute-bg:#1E242B;
  }
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--sans);font-size:13px;
     -webkit-font-smoothing:antialiased;padding:14px 14px 28px}
.top{display:flex;align-items:baseline;justify-content:space-between;gap:12px;
     padding:0 4px 10px;border-bottom:1px solid var(--rule);margin-bottom:10px}
.top h1{font-size:13px;font-weight:600;letter-spacing:-.01em;margin:0}
.top .meta{font-family:var(--mono);font-size:10.5px;color:var(--faint);
           display:flex;gap:10px;align-items:baseline}
.dot{width:6px;height:6px;border-radius:50%;background:var(--good);display:inline-block;margin-right:4px}
.list{display:flex;flex-direction:column;gap:6px}
.card{background:var(--card);border:1px solid var(--rule);border-radius:7px;overflow:hidden}
.row{display:grid;grid-template-columns:92px 42px minmax(0,1fr) auto 26px;
     align-items:center;gap:9px;padding:7px 9px 7px 8px;cursor:pointer;
     background:none;border:0;width:100%;text-align:left;font:inherit;color:inherit}
.row:hover{background:color-mix(in srgb,var(--card) 88%,var(--ink))}
.row:focus-visible{outline:2px solid var(--agent);outline-offset:-2px}
.pill{font-family:var(--mono);font-size:9.5px;letter-spacing:.05em;text-transform:uppercase;
      font-weight:600;padding:3px 0;border-radius:4px;text-align:center;white-space:nowrap}
.pill.you{color:var(--you);background:var(--you-bg)}
.pill.agent{color:var(--agent);background:var(--agent-bg)}
.pill.bad{color:var(--bad);background:var(--bad-bg)}
.pill.good{color:var(--good);background:var(--good-bg)}
.pill.review{color:var(--review);background:var(--review-bg)}
.pill.mute{color:var(--mute);background:var(--mute-bg)}
.num{font-family:var(--mono);font-size:11.5px;color:var(--faint);font-variant-numeric:tabular-nums}
.title{font-size:12.5px;font-weight:500;letter-spacing:-.005em;white-space:nowrap;
       overflow:hidden;text-overflow:ellipsis;min-width:0}
.links{display:flex;gap:4px;align-items:center}
.chip{font-family:var(--mono);font-size:9.5px;letter-spacing:.03em;text-decoration:none;
      color:var(--soft);border:1px solid var(--rule2);border-radius:4px;padding:2.5px 5px;
      white-space:nowrap}
.chip:hover{color:var(--ink);border-color:var(--soft);background:var(--bg)}
.chip.ws{color:var(--ink);background:var(--mute-bg);border-color:transparent;font-weight:600;
         max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chip.ws::before{content:"";display:inline-block;width:5px;height:5px;border-radius:50%;
                 background:var(--agent);margin-right:5px;vertical-align:1px}
.chip.tick{color:var(--agent);border-color:color-mix(in srgb,var(--agent) 40%,transparent)}
.chip.prev{color:var(--good);border-color:color-mix(in srgb,var(--good) 40%,transparent)}
.chev{color:var(--faint);font-size:9px;text-align:center;transition:transform .14s ease}
.card.open .chev{transform:rotate(180deg)}
.body{display:none;padding:0 10px 9px 108px;border-top:1px solid var(--rule)}
.card.open .body{display:block}
.body dl{margin:0;display:grid;grid-template-columns:auto minmax(0,1fr);gap:2px 10px;padding-top:7px}
.body dt{font-family:var(--mono);font-size:9.5px;letter-spacing:.05em;text-transform:uppercase;
         color:var(--faint);padding-top:2px}
.body dd{margin:0;font-size:12px;line-height:1.45;color:var(--ink)}
.body dd.soft{color:var(--soft)}
.facts{margin-top:7px;padding-top:6px;border-top:1px solid var(--rule);
       font-family:var(--mono);font-size:10px;color:var(--faint);
       display:flex;flex-wrap:wrap;gap:3px 12px}
.facts b{font-weight:500;color:var(--soft)}
.empty{padding:26px;text-align:center;color:var(--faint);font-size:12px}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
</style>
</head>
<body>
<div class="top">
  <h1>Board</h1>
  <div class="meta"><span id="counts"></span><span id="stamp"></span></div>
</div>
<div class="list" id="list"></div>
<script id="data" type="application/json">
HTML_HEAD

    printf '%s' "$payload" | sed 's|</|<\\/|g'

    cat <<'HTML_TAIL'
</script>
<script>
const D = JSON.parse(document.getElementById('data').textContent);
const KEY = 'superset-board-open';
const openSet = new Set(JSON.parse(localStorage.getItem(KEY) || '[]'));
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

const ago = iso => {
  if (!iso) return '';
  const m = Math.max(0, Math.round((Date.now() - new Date(iso)) / 60000));
  return m < 1 ? 'just now' : m < 60 ? m + 'm ago' : Math.round(m / 60) + 'h ago';
};

document.getElementById('stamp').textContent = 'polled ' + ago(D.generatedAt);
const needs = D.cards.filter(c => c.pill.tone === 'you').length;
document.getElementById('counts').innerHTML =
  '<span class="dot" style="background:var(--' + (needs ? 'you' : 'good') + ')"></span>' +
  D.cards.length + ' open' + (needs ? ' · ' + needs + ' need you' : '');

const list = document.getElementById('list');
if (!D.cards.length) list.innerHTML = '<div class="empty">Nothing on the board.</div>';

for (const c of D.cards) {
  const el = document.createElement('div');
  el.className = 'card' + (openSet.has(c.id) ? ' open' : '');

  const chips = [];
  if (c.workspaceUrl) chips.push(`<a class="chip ws" href="${esc(c.workspaceUrl)}" title="Open the ${esc(c.workspace || '')} workspace in Superset">${esc(c.workspace || 'workspace')}</a>`);
  if (c.prUrl)      chips.push(`<a class="chip" href="${esc(c.prUrl)}" target="_blank" rel="noreferrer">PR</a>`);
  if (c.ticketUrl)  chips.push(`<a class="chip tick" href="${esc(c.ticketUrl)}" target="_blank" rel="noreferrer">${esc(c.ticketKey)}</a>`);
  if (c.previewUrl) chips.push(`<a class="chip prev" href="${esc(c.previewUrl)}" target="_blank" rel="noreferrer">Preview</a>`);

  const facts = [];
  if (c.review)     facts.push(`<span><b>review</b> ${esc(c.review.toLowerCase().replace(/_/g,' '))}</span>`);
  facts.push(`<span><b>ci</b> ${esc(c.ci)}</span>`);
  if (c.threads)    facts.push(`<span><b>threads</b> ${c.threads} unresolved</span>`);
  if (c.mergeState) facts.push(`<span><b>merge</b> ${esc(c.mergeState.toLowerCase())}</span>`);
  if (c.liveness)   facts.push(`<span><b>agent</b> ${esc(c.liveness)}</span>`);
  if (c.dirty && c.dirty !== '0') facts.push(`<span><b>uncommitted</b> ${esc(c.dirty)}</span>`);
  if (c.branch)     facts.push(`<span>${esc(c.branch)}</span>`);

  el.innerHTML = `
    <button class="row" aria-expanded="${openSet.has(c.id)}">
      <span class="pill ${c.pill.tone}">${esc(c.pill.label)}</span>
      <span class="num">${c.num ? '#' + c.num : '—'}</span>
      <span class="title">${esc(c.title)}</span>
      <span class="links">${chips.join('')}</span>
      <span class="chev">▼</span>
    </button>
    <div class="body">
      <dl>
        <dt>Is</dt><dd class="soft">${esc(c.whatItIs)}</dd>
        <dt>At</dt><dd>${esc(c.whereItsAt)}</dd>
      </dl>
      <div class="facts">${facts.join('')}</div>
    </div>`;

  const btn = el.querySelector('.row');
  btn.addEventListener('click', e => {
    if (e.target.closest('a')) return;            // link clicks must not toggle
    const nowOpen = !el.classList.contains('open');
    el.classList.toggle('open', nowOpen);
    btn.setAttribute('aria-expanded', String(nowOpen));
    nowOpen ? openSet.add(c.id) : openSet.delete(c.id);
    localStorage.setItem(KEY, JSON.stringify([...openSet]));
  });
  list.appendChild(el);
}

setTimeout(() => location.reload(), 90000);   // the file is regenerated behind us
</script>
</body>
</html>
HTML_TAIL
  } > "$OUT"

  # board.md from the same payload. It went stale for five hours because only the
  # HTML was ever regenerated; anything that reads the board as text — a fresh
  # session, a cron run, the operator in a terminal — was reading yesterday.
  printf '%s' "$payload" | jq -r '
    def cell: if . == null or . == "" then "—" else . end;
    "# Board — " + (.generatedAt | sub("T"; " ") | sub("Z"; " UTC")),
    "",
    "Generated by `render-board.sh`. Do not hand-edit — it is overwritten every cycle.",
    "Live view: `board.html`.",
    "",
    (if ([.cards[] | select(.pill.tone == "you")] | length) > 0 then
      ("## Waiting on you\n",
       ([.cards[] | select(.pill.tone == "you")
         | "- **" + (.title) + "**" + (if .num then " (#\(.num))" else "" end)
           + " — " + .pill.label + ", in `" + (.workspace | cell) + "`  \n  " + (.whereItsAt | cell)] | join("\n")),
       "")
     else empty end),
    "## Everything in flight",
    "",
    "| State | Item | PR | Workspace | Where it is |",
    "|---|---|---|---|---|",
    (.cards[] |
      "| " + .pill.label
      + " | " + .title
      + " | " + (if .num then "#\(.num)" else "—" end)
      + " | " + (.workspace | cell)
      + " | " + ((.whereItsAt | cell) | gsub("\\|"; "\\\\|") | .[0:110])
      + " |"),
    "",
    "## Links",
    "",
    (.cards[] | select(.prUrl != null or .ticketUrl != null or .previewUrl != null) |
      "- " + .title + ": "
      + ([ (if .prUrl then "[PR](\(.prUrl))" else empty end),
           (if .ticketUrl then "[\(.ticketKey)](\(.ticketUrl))" else empty end),
           (if .previewUrl then "[preview](\(.previewUrl))" else empty end) ] | join(" · "))
    )' > "$BOARD_DIR/board.md"
}

render
printf 'wrote %s and board.md (%s cards, %s closed and hidden)\n' "$OUT" \
  "$(jq '[.items[]? | select(.state | IN("closed","rejected") | not)] | length' "$BOARD")" \
  "$(jq '[.items[]? | select(.state | IN("closed","rejected"))] | length' "$BOARD")"
if [ "$do_open" = 1 ]; then open "$OUT"; fi

if [ "$watch" = 1 ]; then
  printf 'watching — regenerating every %ss (ctrl-c to stop)\n' "$interval"
  while true; do sleep "$interval"; do_poll=1; render; done
fi
