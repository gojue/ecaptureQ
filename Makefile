.PHONY: protocol server desktop test check release-check version

version:
	python3 scripts/check-version.py

protocol:
	go run ./scripts/check-protocol

server: protocol
	go build -trimpath -o bin/ecaptureq-web ./cmd/server

desktop:
	sh scripts/build-desktop.sh

test: version
	go test -race ./...
	node --test test/*.test.mjs
	python3 -B -m unittest discover -s test -p '*_test.py'

check: test
	go vet ./...
	node --check frontend/app.js
	node --check frontend/protocol-viewers.js

# The release gate must never silently use an adjacent checkout.
release-check: version
	GOWORK=off go run ./scripts/check-protocol
	GOWORK=off go test -race ./...
	GOWORK=off go vet ./...
	GOWORK=off CGO_ENABLED=0 go build -trimpath -o bin/ecaptureq-web ./cmd/server
