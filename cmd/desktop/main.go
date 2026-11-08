//go:build desktop

// Copyright 2026 CFC4N <cfc4n.cs@gmail.com>. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// The desktop entry point embeds the same HTTP handler and UI as cmd/server.
// Wails serves requests through its WebView resource transport, not a TCP port.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/gojue/ecaptureq/frontend"
	"github.com/gojue/ecaptureq/internal/app"
	"github.com/gojue/ecaptureq/internal/cli"
	"github.com/gojue/ecaptureq/internal/httpapi"
	"github.com/gojue/ecaptureq/internal/platform"
	"github.com/wailsapp/wails/v3/pkg/application"
)

func main() {
	if err := run(); err != nil && !errors.Is(err, flag.ErrHelp) {
		fmt.Fprintln(os.Stderr, "eCaptureQ:", err)
		os.Exit(1)
	}
}

func run() error {
	config, err := cli.Parse(os.Args[1:], true)
	if err != nil {
		return err
	}
	service, err := app.New(config.Options)
	if err != nil {
		return err
	}
	defer service.Close()
	// Wails v3 uses wails://localhost on macOS/Linux and
	// http://wails.localhost on Windows. The latter is ordinary HTTP same-origin.
	policy := httpapi.Policy{AdditionalOrigins: []string{"wails://localhost"}}
	shared, err := httpapi.New(config.Options, service.Store(), frontend.Files, policy)
	if err != nil {
		return err
	}
	native := &nativeAdapter{}
	handler, err := httpapi.Mount(config.BasePath, platform.Wrap(shared, native, policy))
	if err != nil {
		return err
	}
	icon, err := frontend.Files.ReadFile("ecaptureq-logo.png")
	if err != nil {
		return fmt.Errorf("load application icon: %w", err)
	}
	desktop := application.New(application.Options{
		Name:        "eCaptureQ",
		Description: "eCapture network protocol inspector",
		Icon:        icon,
		Assets:      application.AssetOptions{Handler: handler},
		Mac:         application.MacOptions{ApplicationShouldTerminateAfterLastWindowClosed: true},
	})
	native.app = desktop
	native.window = desktop.Window.NewWithOptions(application.WebviewWindowOptions{
		Name: "main", Title: "eCaptureQ", Width: 1440, Height: 900,
		MinWidth: 900, MinHeight: 600, URL: config.BasePath,
	})
	desktop.OnShutdown(service.Close)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	service.Start(ctx)
	stopped := make(chan struct{})
	defer close(stopped)
	go func() {
		select {
		case <-ctx.Done():
			desktop.Quit()
		case <-stopped:
		}
	}()
	return desktop.Run()
}
