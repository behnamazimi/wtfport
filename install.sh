#!/bin/bash

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
GITHUB_REPO="${GITHUB_REPO:-behnamazimi/kipo}"
BINARY_NAME="kipo"
VERSION="${VERSION:-latest}"

# Determine install directory (will be set by detect_install_dir)
INSTALL_DIR=""

# Print colored messages
info() {
    echo -e "${BLUE}ℹ${NC} $1"
}

success() {
    echo -e "${GREEN}✓${NC} $1"
}

warning() {
    echo -e "${YELLOW}⚠${NC} $1"
}

error() {
    echo -e "${RED}✗${NC} $1" >&2
}

# Detect platform
detect_platform() {
    local os=""
    local arch=""
    local binary=""

    # Detect OS
    case "$(uname -s)" in
        Linux*)
            os="linux"
            ;;
        Darwin*)
            os="macos"
            ;;
        MINGW*|MSYS*|CYGWIN*)
            os="windows"
            ;;
        *)
            error "Unsupported operating system: $(uname -s)"
            exit 1
            ;;
    esac

    # Detect architecture
    case "$(uname -m)" in
        x86_64|amd64)
            arch="x64"
            ;;
        arm64|aarch64)
            arch="arm64"
            ;;
        *)
            error "Unsupported architecture: $(uname -m)"
            exit 1
            ;;
    esac

    # Map to binary name
    if [ "$os" = "windows" ]; then
        if [ "$arch" = "x64" ]; then
            binary="kipo-win-x64.exe"
        else
            error "Windows ARM64 is not supported yet"
            exit 1
        fi
    elif [ "$os" = "macos" ]; then
        if [ "$arch" = "x64" ]; then
            binary="kipo-macos-x64"
        elif [ "$arch" = "arm64" ]; then
            binary="kipo-macos-arm64"
        fi
    elif [ "$os" = "linux" ]; then
        if [ "$arch" = "x64" ]; then
            binary="kipo-linux-x64"
        else
            error "Linux ARM64 is not supported yet"
            exit 1
        fi
    fi

    echo "$binary"
}

# Check for required tools
check_requirements() {
    local missing_tools=()

    if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
        missing_tools+=("curl or wget")
    fi

    if [ ${#missing_tools[@]} -ne 0 ]; then
        error "Missing required tools: ${missing_tools[*]}"
        error "Please install them and try again."
        exit 1
    fi

    # Determine download tool
    if command -v curl >/dev/null 2>&1; then
        DOWNLOAD_CMD="curl"
    else
        DOWNLOAD_CMD="wget"
    fi
}

# Download binary
download_binary() {
    local binary_name=$1
    local output_path=$2
    local download_url=""

    info "Downloading $binary_name..."

    if [ "$VERSION" = "latest" ]; then
        # Try to get latest release URL
        download_url="https://github.com/${GITHUB_REPO}/releases/latest/download/${binary_name}"
    else
        download_url="https://github.com/${GITHUB_REPO}/releases/download/${VERSION}/${binary_name}"
    fi

    # Create temp directory
    local temp_dir=$(mktemp -d)
    local temp_file="${temp_dir}/${binary_name}"

    # Download using curl or wget
    if [ "$DOWNLOAD_CMD" = "curl" ]; then
        if ! curl -fsSL -o "$temp_file" "$download_url"; then
            error "Failed to download binary from $download_url"
            error "Make sure the release exists and the binary is available."
            rm -rf "$temp_dir"
            exit 1
        fi
    else
        if ! wget -q -O "$temp_file" "$download_url"; then
            error "Failed to download binary from $download_url"
            error "Make sure the release exists and the binary is available."
            rm -rf "$temp_dir"
            exit 1
        fi
    fi

    # Move to final location
    mv "$temp_file" "$output_path"
    rm -rf "$temp_dir"

    success "Downloaded $binary_name"
}

# Install binary
install_binary() {
    local binary_path=$1
    local install_path="${INSTALL_DIR}/${BINARY_NAME}"

    # Create install directory if it doesn't exist
    mkdir -p "$INSTALL_DIR"

    # Copy binary
    cp "$binary_path" "$install_path"

    # Make executable
    chmod +x "$install_path"

    success "Installed kipo to $install_path"
}

# Check if directory is in PATH
is_in_path() {
    local dir=$1
    case ":$PATH:" in
        *:"$dir":*)
            return 0
            ;;
        *)
            return 1
            ;;
    esac
}

# Detect best install directory
detect_install_dir() {
    # Check if /usr/local/bin is in PATH (system-wide, requires sudo)
    if is_in_path "/usr/local/bin"; then
        if [ -w "/usr/local/bin" ] 2>/dev/null; then
            # User can write without sudo
            echo "/usr/local/bin"
            return 0
        fi
    fi

    # Check if ~/bin exists and is in PATH
    if [ -d "${HOME}/bin" ] && is_in_path "${HOME}/bin"; then
        echo "${HOME}/bin"
        return 0
    fi

    # Check if ~/.local/bin is in PATH
    if is_in_path "${HOME}/.local/bin"; then
        echo "${HOME}/.local/bin"
        return 0
    fi

    # Prefer ~/bin if it exists (even if not in PATH, user might have it)
    if [ -d "${HOME}/bin" ]; then
        echo "${HOME}/bin"
        return 0
    fi

    # Default to ~/.local/bin (XDG standard)
    echo "${HOME}/.local/bin"
}

# Get shell config file
get_shell_config() {
    local shell_name=$(basename "$SHELL" 2>/dev/null || echo "bash")
    local config_file=""

    case "$shell_name" in
        zsh)
            config_file="${HOME}/.zshrc"
            ;;
        bash)
            if [ -f "${HOME}/.bash_profile" ]; then
                config_file="${HOME}/.bash_profile"
            else
                config_file="${HOME}/.bashrc"
            fi
            ;;
        fish)
            config_file="${HOME}/.config/fish/config.fish"
            ;;
        *)
            config_file="${HOME}/.profile"
            ;;
    esac

    echo "$config_file"
}

# Setup PATH
setup_path() {
    if is_in_path "$INSTALL_DIR"; then
        success "$INSTALL_DIR is already in your PATH"
        return 0
    fi

    # If installing to system directory, no PATH setup needed
    if [ "$INSTALL_DIR" = "/usr/local/bin" ]; then
        return 0
    fi

    warning "$INSTALL_DIR is not in your PATH"
    local config_file=$(get_shell_config)
    
    # Determine the correct export line based on install directory
    local export_line=""
    if [ "$INSTALL_DIR" = "${HOME}/bin" ]; then
        export_line="export PATH=\"\$HOME/bin:\$PATH\""
    else
        export_line="export PATH=\"\$HOME/.local/bin:\$PATH\""
    fi

    info "To add $INSTALL_DIR to your PATH, run:"
    echo ""
    echo "  echo '$export_line' >> $config_file"
    echo "  source $config_file"
    echo ""
    info "Or manually add this line to $config_file:"
    echo "  $export_line"
    
    # Offer to add it automatically
    echo ""
    read -p "Would you like to add it to your PATH now? (y/N) " -n 1 -r
    echo ""
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        if ! grep -q "$export_line" "$config_file" 2>/dev/null; then
            echo "$export_line" >> "$config_file"
            success "Added $INSTALL_DIR to PATH in $config_file"
            info "Run 'source $config_file' or restart your terminal to use it."
        else
            info "PATH entry already exists in $config_file"
        fi
    fi
}

# Verify installation
verify_installation() {
    local install_path="${INSTALL_DIR}/${BINARY_NAME}"

    if [ ! -f "$install_path" ]; then
        error "Installation verification failed: binary not found at $install_path"
        exit 1
    fi

    if [ ! -x "$install_path" ]; then
        error "Installation verification failed: binary is not executable"
        exit 1
    fi

    # Try to run the binary to verify it works
    if "$install_path" --version >/dev/null 2>&1 || "$install_path" --help >/dev/null 2>&1; then
        success "Installation verified successfully"
    else
        warning "Could not verify binary execution, but it was installed successfully"
    fi
}

# Main installation function
main() {
    info "Installing kipo..."

    # Check for Windows (native, not Git Bash/WSL)
    if [ "$(uname -s)" = "MINGW"* ] || [ "$(uname -s)" = "MSYS"* ]; then
        warning "You're running on Windows. This script works best in Git Bash or WSL."
        warning "For native Windows, please download the .exe manually from:"
        warning "https://github.com/${GITHUB_REPO}/releases/latest"
        echo ""
        read -p "Continue anyway? (y/N) " -n 1 -r
        echo ""
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            exit 0
        fi
    fi

    # Check requirements
    check_requirements

    # Detect install directory
    INSTALL_DIR=$(detect_install_dir)
    
    # Check if we need sudo for system-wide installation
    local needs_sudo=false
    if [ "$INSTALL_DIR" = "/usr/local/bin" ] && [ ! -w "/usr/local/bin" ] 2>/dev/null; then
        needs_sudo=true
        info "System-wide installation to /usr/local/bin requires sudo"
        echo ""
        read -p "Install system-wide? (Y/n) " -n 1 -r
        echo ""
        if [[ $REPLY =~ ^[Nn]$ ]]; then
            # Fall back to user directory
            INSTALL_DIR="${HOME}/.local/bin"
            needs_sudo=false
            info "Using user directory: $INSTALL_DIR"
        fi
    else
        info "Install directory: $INSTALL_DIR"
    fi

    # Detect platform and get binary name
    local binary_name=$(detect_platform)
    info "Detected platform: $binary_name"

    # Create temp directory for download
    local temp_dir=$(mktemp -d)
    local temp_binary="${temp_dir}/${binary_name}"

    # Download binary
    download_binary "$binary_name" "$temp_binary"

    # Install binary (with sudo if needed)
    if [ "$needs_sudo" = true ] && [ "$INSTALL_DIR" = "/usr/local/bin" ]; then
        info "Installing to $INSTALL_DIR (requires sudo)..."
        sudo cp "$temp_binary" "${INSTALL_DIR}/${BINARY_NAME}"
        sudo chmod +x "${INSTALL_DIR}/${BINARY_NAME}"
        success "Installed kipo to $INSTALL_DIR"
    else
        install_binary "$temp_binary"
    fi

    # Cleanup
    rm -rf "$temp_dir"

    # Setup PATH (only needed for user directories)
    if [ "$INSTALL_DIR" != "/usr/local/bin" ]; then
        setup_path
    fi

    # Verify installation
    verify_installation

    echo ""
    success "kipo has been installed successfully!"
    
    if is_in_path "$INSTALL_DIR"; then
        info "Run 'kipo' to start using it."
    else
        info "Run '${INSTALL_DIR}/kipo' to start using it."
        if [ "$INSTALL_DIR" != "/usr/local/bin" ]; then
            warning "Remember to add $INSTALL_DIR to your PATH or restart your terminal."
        fi
    fi
}

# Run main function
main "$@"

