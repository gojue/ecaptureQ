//go:build desktop

// Copyright 2026 CFC4N <cfc4n.cs@gmail.com>. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"errors"
	"os"
	"path/filepath"

	"github.com/wailsapp/wails/v3/pkg/application"
)

type nativeAdapter struct {
	app    *application.App
	window *application.WebviewWindow
}

func (n *nativeAdapter) SaveFile(filename, content string) (bool, error) {
	dialog := n.app.Dialog.SaveFile()
	dialog.SetOptions(&application.SaveFileDialogOptions{
		Title: "导出 eCaptureQ 记录", Filename: filename, Window: n.window,
		CanCreateDirectories: true,
		Filters:              []application.FileFilter{{DisplayName: "JSON", Pattern: "*.json"}},
	})
	path, err := dialog.PromptForSingleSelection()
	if err != nil || path == "" {
		return false, err
	}
	// Use a private temporary file and replace only after the complete export is
	// written. No path is accepted from captured data or the frontend request.
	file, err := os.CreateTemp(filepath.Dir(path), ".ecaptureq-export-*")
	if err != nil {
		return false, err
	}
	temporary := file.Name()
	defer os.Remove(temporary)
	if _, err = file.WriteString(content); err != nil {
		_ = file.Close()
		return false, err
	}
	if err = file.Sync(); err != nil {
		_ = file.Close()
		return false, err
	}
	if err = file.Close(); err != nil {
		return false, err
	}
	if err = os.Rename(temporary, path); err != nil {
		return false, err
	}
	return true, nil
}

func (n *nativeAdapter) CopyText(text string) error {
	if !n.app.Clipboard.SetText(text) {
		return errors.New("clipboard unavailable")
	}
	return nil
}

func (n *nativeAdapter) OpenURL(url string) error { return n.app.Browser.OpenURL(url) }
