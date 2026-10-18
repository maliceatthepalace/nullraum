GO      ?= go
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS := -s -w -X main.version=$(VERSION)

.PHONY: all wasm build test release clean

all: build

wasm:
	GOOS=js GOARCH=wasm $(GO) build -trimpath -ldflags="-s -w" -o web/app/nullraum.wasm ./cmd/wasm
	cp "$$($(GO) env GOROOT)/lib/wasm/wasm_exec.js" web/app/wasm_exec.js

build: wasm
	CGO_ENABLED=0 $(GO) build -trimpath -ldflags="$(LDFLAGS)" -o bin/nullraum ./cmd/nullraum

test: wasm
	$(GO) vet ./...
	$(GO) test ./...

release: wasm
	@mkdir -p dist
	@for t in linux/amd64 linux/arm64 darwin/amd64 darwin/arm64 windows/amd64 windows/arm64; do \
		os=$${t%/*}; arch=$${t#*/}; ext=; [ $$os = windows ] && ext=.exe; \
		echo "→ $$os/$$arch"; \
		CGO_ENABLED=0 GOOS=$$os GOARCH=$$arch $(GO) build -trimpath -ldflags="$(LDFLAGS)" -o dist/nullraum-$$os-$$arch$$ext ./cmd/nullraum || exit 1; \
	done
	cd dist && sha256sum nullraum-* > SHA256SUMS

clean:
	rm -rf bin dist web/app/nullraum.wasm web/app/wasm_exec.js
