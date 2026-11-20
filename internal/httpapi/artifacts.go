// Copyright 2026 CFC4N. SPDX-License-Identifier: Apache-2.0

package httpapi

import (
	"context"
	"io"
	"mime"
	"net/http"
	"time"

	"github.com/gojue/ecaptureq/internal/app"
)

func artifactDownload(w http.ResponseWriter, r *http.Request, live *app.Store, policy Policy) {
	if !policy.ValidOrigin(r) || r.Header.Get("Sec-Fetch-Site") == "cross-site" {
		writeJSON(w, r, http.StatusForbidden, []byte(`{"error":"origin_rejected"}`))
		return
	}
	file, err := live.OpenArtifact(r.URL.Query().Get("session"), r.URL.Query().Get("id"))
	if err != nil {
		writeJSON(w, r, http.StatusNotFound, []byte(`{"error":"artifact_not_found"}`))
		return
	}
	defer file.Close()
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": file.Info.Filename}))
	// Native files can exceed the normal API's 15-second response budget.
	// Keep a finite download budget while allowing streaming large artifacts.
	_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(15 * time.Minute))
	// A fixed snapshot supports streaming/ranges without holding capture locks or
	// loading native files into strings, JSON, or browser memory.
	http.ServeContent(w, r, file.Info.Filename, time.Time{}, contextReadSeeker{ctx: r.Context(), ReadSeeker: file})
}

// Web authentication cancels this request context when its session is revoked.
// Check between chunks so a long download stops after logout or disconnection.
type contextReadSeeker struct {
	ctx context.Context
	io.ReadSeeker
}

func (r contextReadSeeker) Read(data []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.ReadSeeker.Read(data)
}

func (r contextReadSeeker) Seek(offset int64, whence int) (int64, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.ReadSeeker.Seek(offset, whence)
}
