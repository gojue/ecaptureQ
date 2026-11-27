// Copyright 2026 CFC4N. SPDX-License-Identifier: Apache-2.0

package app

// ClearRecords removes the retained application records without interrupting
// sources or changing the service session. The mapper queues keep their bounded
// pending slots: a late HTTP/1 response must consume its original slot instead
// of being paired with a request that arrived after the clear. Their retained
// check prevents cleared requests from being restored by a response.
func (s *Store) ClearRecords() (Status, error) {
	s.ingestMu.Lock()
	defer s.ingestMu.Unlock()
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closing {
		return Status{}, ErrStoreClosed
	}
	s.records = make(map[string]storedRecord)
	s.order = nil
	s.bytes = 0
	s.recordsRevision++
	s.notifyLocked()
	return s.statusLocked(), nil
}
