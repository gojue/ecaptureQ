.PHONY: protocol server desktop test check release-check

protocol:
	go run ./scripts/check-protocol

server: protocol
	go build -trimpath -o bin/ecaptureq-server ./cmd/server

desktop:
	sh scripts/build-desktop.sh

test:
	go test -race ./...
	node --test test/*.test.mjs

check: test
	go vet ./...
	node --check frontend/app.js
	node --check frontend/protocol-viewers.js

# The release gate must never silently use an adjacent checkout.
release-check:
	GOWORK=off go run ./scripts/check-protocol
	GOWORK=off go test -race ./...
	GOWORK=off go vet ./...
	GOWORK=off CGO_ENABLED=0 go build -trimpath -o bin/ecaptureq-server ./cmd/server
