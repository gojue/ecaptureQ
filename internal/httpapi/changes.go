// Copyright 2026 CFC4N. SPDX-License-Identifier: Apache-2.0

package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/gojue/ecaptureq/internal/app"
)

func changes(w http.ResponseWriter, r *http.Request, live *app.Store, policy Policy, slots chan struct{}) {
	if !policy.ValidOrigin(r) || r.Header.Get("Sec-Fetch-Site") == "cross-site" {
		writeJSON(w, r, http.StatusForbidden, []byte(`{"error":"origin_rejected"}`))
		return
	}
	query := r.URL.Query()
	session, rawRevision := query.Get("session"), query.Get("revision")
	var revision uint64
	var err error
	if rawRevision != "" {
		revision, err = strconv.ParseUint(rawRevision, 10, 64)
	}
	if err != nil || len(session) > 128 {
		writeJSON(w, r, http.StatusBadRequest, []byte(`{"error":"invalid_cursor"}`))
		return
	}
	if r.Method == http.MethodHead {
		writeValue(w, r, live.Status())
		return
	}
	select {
	case slots <- struct{}{}:
		defer func() { <-slots }()
	default:
		w.Header().Set("Retry-After", "5")
		writeJSON(w, r, http.StatusServiceUnavailable, []byte(`{"error":"too_many_waiters"}`))
		return
	}
	// Stay below the Web server's 15-second write timeout. Desktop uses the
	// same finite response, without requiring streaming or a network listener.
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	status, err := live.WaitForChange(ctx, session, revision)
	switch {
	case r.Context().Err() != nil:
		return
	case errors.Is(err, context.DeadlineExceeded):
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(http.StatusNoContent)
	case err != nil:
		writeJSON(w, r, http.StatusServiceUnavailable, []byte(`{"error":"service_stopping"}`))
	default:
		writeValue(w, r, status)
	}
}
