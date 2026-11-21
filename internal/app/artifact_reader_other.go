//go:build !windows

// Copyright 2026 CFC4N. SPDX-License-Identifier: Apache-2.0

package app

import "os"

func openArtifactFileReader(path string) (*os.File, error) { return os.Open(path) }
