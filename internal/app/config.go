// Copyright 2026 CFC4N <cfc4n.cs@gmail.com>. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package app

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
)

// The manifest describes operator-supplied launch metadata. It is never executed
// and is not an attestation supplied by the eCaptureQ event protocol.
func LoadSources(path string, options *Options) error {
	file, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("open sources: %w", err)
	}
	defer func() { _ = file.Close() }()
	data, err := io.ReadAll(io.LimitReader(file, (128<<10)+1))
	if err != nil || len(data) > 128<<10 {
		return errors.New("sources manifest cannot exceed 128 KiB")
	}
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.DisallowUnknownFields()
	var sources []SourceConfig
	if err := decoder.Decode(&sources); err != nil {
		return fmt.Errorf("decode sources: %w", err)
	}
	if decoder.Decode(new(any)) != io.EOF {
		return errors.New("sources manifest must contain one JSON array")
	}
	if sources == nil || len(sources) > 16 {
		return errors.New("sources manifest must contain an array of up to 16 sources")
	}
	for _, source := range sources {
		options.Endpoints = append(options.Endpoints, source.Endpoint)
	}
	options.Sources = sources
	options.SourcesFile, options.SourcesHash = path, sha256.Sum256(data)
	return nil
}
