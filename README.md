# ecaptureQ

A modern, cross-platform GUI for **eCapture**, the powerful eBPF-based TLS traffic capture tool.

> **Note:** This project is currently under active development. Features and the user interface are subject to change.

## Purpose

`eCapture` is a fantastic command-line tool that leverages **eBPF** to capture encrypted network traffic (like TLS) without requiring a Certificate Authority (CA).

The goal of `ecaptureQ` is to wrap the power of `eCapture` in a user-friendly graphical interface. It allows developers and analysts to visually manage captures and analyze traffic in real-time on Linux and Android, simplifying the overall workflow.

## Tech Stack

This project is built with a combination of modern technologies selected for performance and a quality user experience:

  * **Core Engine**: **eCapture** (The underlying eBPF-based capture tool)
  * **Framework**: **Tauri**
  * **Backend**: **Rust**, using Tokio for asynchronous operations and Polars for high-performance data handling.
  * **Frontend**: **React** with **TypeScript**, styled using **Tailwind CSS**.

## Status: Work in Progress

`ecaptureQ` is in an early stage of development. We are actively working on:

  * Improving stability and feature integration with `eCapture`.
  * Refining the user interface and overall experience.
  * Expanding support for more `eCapture` functionalities.

## Development & Build

This section outlines the process for compiling the project for Android.

### Prerequisites

Before you begin, ensure you have the following installed and configured:

  * **Rust Toolchain**: `rustc`, `cargo`
  * **pnpm**: A Node.js package manager
  * **Android SDK & NDK**: Can be installed via Android Studio
  * Environment variables `ANDROID_HOME` and `NDK_HOME` must be set correctly.

### Android Certificate Signing

To publish the application on Android, a signing certificate is required. You can generate a new keystore file using the `keytool` command.

```shell
keytool -genkey -v -keystore ~/upload-keystore.jks -keyalg RSA -keysize 2048 -validity 10000 -alias upload
```

For more details, refer to the official Tauri documentation on Android signing.

### Build Steps

1.  **Install Frontend Dependencies**:

    ```bash
    pnpm install
    ```

2.  **Initialize Android Project** (Required for the first time):

    ```bash
    pnpm tauri android init
    ```

3.  **Build the Final Android Application**:
    This command bundles the Tauri Rust core and the React frontend code into a final APK file for the `aarch64` architecture.

    ```bash
    pnpm android:build
    ```

## Directory Structure

```
.
├── public/                # Static assets
├── scripts/
│   └── log.sh             # Helper script to view Android logcat
├── src/                   # Frontend React source code
│   ├── components/        # React components
│   ├── hooks/             # Custom Hooks (e.g., useAppState)
│   ├── services/          # Frontend services (e.g., apiService)
│   ├── types/             # TypeScript type definitions
│   └── App.tsx            # Main application component
├── src-tauri/             # Backend Rust source code
│   ├── binaries/          # Embedded binaries (e.g., capture tool)
│   ├── capabilities/      # Tauri permission configurations
│   ├── src/
│   │   ├── core/          # Core data processing (Actor, Polars)
│   │   ├── services/      # Background services (Capture, WebSocket)
│   │   └── tauri_bridge/  # Commands and state for frontend interaction
│   │   └── lib.rs         # Rust lib main entry point
│   ├── Cargo.toml         # Rust dependency configuration
│   └── tauri.conf.json    # Tauri application configuration
└── package.json           # Frontend project and script configuration
```