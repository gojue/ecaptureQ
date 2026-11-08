// Copyright 2026 CFC4N <cfc4n.cs@gmail.com>. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Package platform provides the small, testable HTTP boundary for native UI
// actions. It does not import Wails or own capture connections.
package platform

import (
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"unicode"

	"github.com/gojue/ecaptureq/internal/httpapi"
)

const (
	MaxExportBytes    = 64 << 20
	MaxClipboardBytes = 4 << 20
)

// Native is implemented only by the desktop entry point. SaveFile must prompt
// for a destination; the frontend can suggest a name but cannot choose a path.
type Native interface {
	SaveFile(filename, content, locale string) (saved bool, err error)
	CopyText(text string) error
	OpenURL(url string) error
}

type handler struct {
	next     http.Handler
	native   Native
	policy   httpapi.Policy
	exportMu sync.Mutex
}

// Wrap adds native capabilities to a shared handler. Mount it beneath the same
// base path as the UI, before handing it to Wails' internal asset server.
func Wrap(next http.Handler, native Native, policy httpapi.Policy) http.Handler {
	return &handler{next: next, native: native, policy: policy}
}

func (h *handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/api/platform" && !strings.HasPrefix(r.URL.Path, "/api/platform/") {
		h.next.ServeHTTP(w, r)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-Ecaptureq-UI", "1")
	if r.URL.Path == "/api/platform" {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			respond(w, r, http.StatusMethodNotAllowed, map[string]any{"error": "method_not_allowed"})
			return
		}
		respond(w, r, http.StatusOK, map[string]any{"desktop": true, "export": true, "clipboard": true, "openURL": true})
		return
	}
	var limit int64
	switch r.URL.Path {
	case "/api/platform/export":
		// JSON escaping can expand strings; allow bounded encoding overhead.
		limit = 2 * MaxExportBytes
	case "/api/platform/clipboard":
		limit = 6*MaxClipboardBytes + 1024
	case "/api/platform/open-url":
		limit = 16 << 10
	default:
		respond(w, r, http.StatusNotFound, map[string]any{"error": "not_found"})
		return
	}
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		respond(w, r, http.StatusMethodNotAllowed, map[string]any{"error": "method_not_allowed"})
		return
	}
	if !httpapi.CheckWriteRequest(w, r, h.policy) {
		return
	}
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		respond(w, r, http.StatusUnsupportedMediaType, map[string]any{"error": "json_required"})
		return
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, limit))
	decoder.DisallowUnknownFields()
	decode := func(target any) bool {
		if err := decoder.Decode(target); err != nil {
			var tooLarge *http.MaxBytesError
			if errors.As(err, &tooLarge) {
				respond(w, r, http.StatusRequestEntityTooLarge, map[string]any{"error": "payload_too_large"})
			} else {
				respond(w, r, http.StatusBadRequest, map[string]any{"error": "invalid_json"})
			}
			return false
		}
		if decoder.Decode(new(any)) != io.EOF {
			respond(w, r, http.StatusBadRequest, map[string]any{"error": "invalid_json"})
			return false
		}
		return true
	}
	switch r.URL.Path {
	case "/api/platform/export":
		var request struct {
			Filename string `json:"filename"`
			Content  string `json:"content"`
			Locale   string `json:"locale"`
		}
		if !decode(&request) {
			return
		}
		switch request.Locale {
		case "":
			request.Locale = "en"
		case "en", "zh-CN":
		default:
			respond(w, r, http.StatusBadRequest, map[string]any{"error": "invalid_locale"})
			return
		}
		if !validFilename(request.Filename) {
			respond(w, r, http.StatusBadRequest, map[string]any{"error": "invalid_filename"})
			return
		}
		if len(request.Content) > MaxExportBytes {
			respond(w, r, http.StatusRequestEntityTooLarge, map[string]any{"error": "export_exceeds_64_mib"})
			return
		}
		if !h.exportMu.TryLock() {
			respond(w, r, http.StatusConflict, map[string]any{"error": "export_dialog_already_open"})
			return
		}
		defer h.exportMu.Unlock()
		saved, err := h.native.SaveFile(request.Filename, request.Content, request.Locale)
		if err != nil {
			respond(w, r, http.StatusInternalServerError, map[string]any{"error": "export_failed"})
			return
		}
		respond(w, r, http.StatusOK, map[string]any{"saved": saved, "cancelled": !saved})
	case "/api/platform/clipboard":
		var request struct {
			Text string `json:"text"`
		}
		if !decode(&request) {
			return
		}
		if len(request.Text) > MaxClipboardBytes {
			respond(w, r, http.StatusRequestEntityTooLarge, map[string]any{"error": "clipboard_exceeds_4_mib"})
			return
		}
		if err := h.native.CopyText(request.Text); err != nil {
			respond(w, r, http.StatusInternalServerError, map[string]any{"error": "clipboard_failed"})
			return
		}
		respond(w, r, http.StatusOK, map[string]any{"ok": true})
	case "/api/platform/open-url":
		var request struct {
			URL string `json:"url"`
		}
		if !decode(&request) {
			return
		}
		if !validExternalURL(request.URL) {
			respond(w, r, http.StatusBadRequest, map[string]any{"error": "invalid_external_url"})
			return
		}
		if err := h.native.OpenURL(request.URL); err != nil {
			respond(w, r, http.StatusInternalServerError, map[string]any{"error": "open_url_failed"})
			return
		}
		respond(w, r, http.StatusOK, map[string]any{"ok": true})
	}
}

func validFilename(name string) bool {
	return name != "" && name != "." && name != ".." && len(name) <= 255 && !strings.ContainsAny(name, "/\\:") && strings.IndexFunc(name, unicode.IsControl) < 0
}

func validExternalURL(value string) bool {
	u, err := url.Parse(value)
	return err == nil && len(value) <= 8192 && strings.IndexFunc(value, unicode.IsControl) < 0 &&
		(u.Scheme == "http" || u.Scheme == "https") && u.Hostname() != "" && u.User == nil && u.Opaque == ""
}

func respond(w http.ResponseWriter, r *http.Request, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if r.Method != http.MethodHead {
		_ = json.NewEncoder(w).Encode(value)
	}
}
