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

test:
	swift test

clean:
	swift package clean
	@rm -rf dist
