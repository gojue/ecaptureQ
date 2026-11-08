// Copyright 2026 CFC4N. SPDX-License-Identifier: Apache-2.0

// Package frontend contains the shared browser and desktop interface.
package frontend

import "embed"

// Files is the same asset tree for the HTTP server and the Wails asset server.
//go:embed *.html *.css *.js *.json *.svg
var Files embed.FS
