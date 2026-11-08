// Copyright 2026 CFC4N <cfc4n.cs@gmail.com>. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package app

import (
	"context"
	"sync"
)

// Service owns one independent collection session. It has no window or listener.
type Service struct {
	store  *Store
	mu     sync.Mutex
	cancel context.CancelFunc
	closed bool
}

func New(options Options) (*Service, error) {
	store, err := NewStore(options)
	if err != nil {
		return nil, err
	}
	return &Service{store: store}, nil
}

func (s *Service) Store() *Store { return s.store }

// Start is idempotent; a closed session cannot be restarted.
func (s *Service) Start(parent context.Context) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed || s.cancel != nil {
		return
	}
	ctx, cancel := context.WithCancel(parent)
	s.cancel = cancel
	s.store.Start(ctx)
}

// Close cancels receive loops, in-flight dials and reconnect timers, then joins
// every connector. Concurrent callers all wait until cleanup completes.
func (s *Service) Close() {
	s.mu.Lock()
	s.closed = true
	if s.cancel != nil {
		s.cancel()
	}
	s.mu.Unlock()
	s.store.Wait()
}
