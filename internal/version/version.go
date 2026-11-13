// Copyright 2026 CFC4N <cfc4n.cs@gmail.com>. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Package version reports the running eCaptureQ release identity. The default
// matches VERSION and package.json; release builds override it at link time
// with -ldflags "-X github.com/gojue/ecaptureq/internal/version.Version=...".
package version

// Version is the semantic version of this build without a leading "v".
var Version = "1.1.0"
