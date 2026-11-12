// Copyright 2026 CFC4N. SPDX-License-Identifier: Apache-2.0

package app

import (
	"context"
	"errors"
	"time"
)

var ErrStoreClosed = errors.New("service_stopping")

// notifyLocked broadcasts without blocking ingestion or retaining an event queue.
func (s *Store) notifyLocked() {
	s.revision++
	close(s.changed)
	s.changed = make(chan struct{})
}

// WaitForChange atomically checks the cursor and subscribes to the next change.
// A different service session always invalidates the cursor, even at revision 0.
func (s *Store) WaitForChange(ctx context.Context, session string, revision uint64) (Status, error) {
	for {
		if err := ctx.Err(); err != nil {
			return Status{}, err
		}
		s.mu.Lock()
		if s.closing {
			s.mu.Unlock()
			return Status{}, ErrStoreClosed
		}
		if session != s.started.UTC().Format(time.RFC3339Nano) || revision != s.revision {
			status := s.statusLocked()
			s.mu.Unlock()
			return status, nil
		}
		changed := s.changed
		s.mu.Unlock()
		select {
		case <-ctx.Done():
			return Status{}, ctx.Err()
		case <-changed:
		}
	}
}
