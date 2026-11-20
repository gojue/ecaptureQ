// Copyright 2026 CFC4N. SPDX-License-Identifier: Apache-2.0

package auth

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

type deadlineWriter struct {
	*httptest.ResponseRecorder
	deadline time.Time
}

func (w *deadlineWriter) SetWriteDeadline(deadline time.Time) error {
	w.deadline = deadline
	return nil
}

func TestSessionGuardPreservesStreamingDeadlineAndAuthorization(t *testing.T) {
	inner := &deadlineWriter{ResponseRecorder: httptest.NewRecorder()}
	rejected := false
	guard := &sessionWriter{ResponseWriter: inner, valid: func() bool { return false }, reject: func() { rejected = true }}
	deadline := time.Now().Add(time.Minute)
	if err := http.NewResponseController(guard).SetWriteDeadline(deadline); err != nil || !inner.deadline.Equal(deadline) {
		t.Fatalf("stream deadline lost: %v", err)
	}
	_, _ = guard.Write([]byte("sensitive native bytes"))
	if !rejected || inner.Body.Len() != 0 {
		t.Fatal("response controls bypassed authorization")
	}
}
