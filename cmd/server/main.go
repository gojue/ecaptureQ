// Copyright 2026 CFC4N <cfc4n.cs@gmail.com>. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/gojue/ecaptureq/frontend"
	"github.com/gojue/ecaptureq/internal/app"
	"github.com/gojue/ecaptureq/internal/cli"
	"github.com/gojue/ecaptureq/internal/httpapi"
)

func main() {
	if err := run(); err != nil && !errors.Is(err, flag.ErrHelp) {
		fmt.Fprintln(os.Stderr, "eCaptureQ:", err)
		os.Exit(1)
	}
}

func run() error {
	config, err := cli.Parse(os.Args[1:], false)
	if err != nil {
		return err
	}
	service, err := app.New(config.Options)
	if err != nil {
		return err
	}
	defer service.Close()
	handler, err := httpapi.New(config.Options, service.Store(), frontend.Files, httpapi.Policy{})
	if err != nil {
		return err
	}
	handler, err = httpapi.Mount(config.BasePath, handler)
	if err != nil {
		return err
	}
	server := &http.Server{Addr: config.Addr, Handler: handler, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 15 * time.Second, IdleTimeout: time.Minute}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	service.Start(ctx)
	finished := make(chan error, 1)
	go func() { finished <- server.ListenAndServe() }()
	select {
	case err := <-finished:
		return err
	case <-ctx.Done():
		service.Close()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdownCtx); err != nil {
			_ = server.Close()
			return err
		}
		if err := <-finished; !errors.Is(err, http.ErrServerClosed) {
			return err
		}
		return nil
	}
}
