# There is no Xcode on the target machine — only Command Line Tools — so the .app
# is assembled by hand from the SwiftPM binary rather than by xcodebuild.

APP     := dist/NiceJobTeam.app
BIN     := .build/release/Board
CONTENTS = $(APP)/Contents

.PHONY: all build bundle run install clean test

all: bundle

build:
	swift build -c release

# Rebuilding into a running bundle leaves the old process on the stale binary, so
# stop it first — this is the one process the Makefile is entitled to kill.
bundle: build
	@rm -rf $(APP)
	@mkdir -p $(CONTENTS)/MacOS $(CONTENTS)/Resources
	@cp $(BIN) $(CONTENTS)/MacOS/Board
	@cp Resources/Info.plist $(CONTENTS)/Info.plist
	@printf 'APPL????' > $(CONTENTS)/PkgInfo
	@touch $(APP)
	@# Ad-hoc sign so UNUserNotificationCenter has a stable code identity to
	@# grant notification permission against — an unsigned bundle is refused.
	@codesign --force --sign - $(APP) 2>/dev/null || echo "warn: codesign failed — notifications may be denied"
	@echo "built $(APP)"

run: bundle
	@pkill -x Board 2>/dev/null || true
	@open $(APP)

# ~/Applications, not /Applications: no sudo, and it is a personal tool.
install: bundle
	@mkdir -p $(HOME)/Applications
	@rm -rf $(HOME)/Applications/NiceJobTeam.app
	@cp -R $(APP) $(HOME)/Applications/NiceJobTeam.app
	@echo "installed $(HOME)/Applications/NiceJobTeam.app"

# cli/dist is gitignored and the wiring tests exercise the built CLI, so build
# before test on a fresh checkout. npm ci, not install, so the lockfile stays
# the one truth about the devDeps. run.sh is gone: its surviving checks live in
# cli/test/wiring.test.ts and run as part of `npm test`.
test:
	swift test
	cd cli && npm ci && npm run build && npm test

clean:
	swift package clean
	@rm -rf dist

# ── Publishing to the public repository ───────────────────────────────────────
# The fixtures here are real captures and the docs use real branches, so the
# public repo gets a scrubbed snapshot, never this history. tools/publish/README.md
# is the procedure; these are its three steps. publish-verify is the one that
# matters — it proves the scrubbed tree still builds and passes, which is how a
# rename that broke the fixtures' internal arithmetic gets caught before anyone
# else sees it.
.PHONY: publish-stage publish-verify publish

publish-stage:
	node tools/publish/scrub.mjs

publish-verify: publish-stage
	cd dist/publish && swift test
	cd dist/publish/cli && npm ci --silent && npm run build
	node tools/publish/repin.mjs
	cd dist/publish/cli && npm test

# Commits the staged tree into a throwaway clone and stops. Pass the message,
# review the diff it prints, then push with the command it gives you.
publish:
	@test -n "$(M)" || (echo 'usage: make publish M="the commit message"'; exit 2)
	node tools/publish/publish.mjs -m "$(M)"
