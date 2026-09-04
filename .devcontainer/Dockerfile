# Dev container image based on Ubuntu 26.04 with zsh + Oh My Zsh + dsh
FROM ubuntu:26.04

# 安装基础组件（gh = GitHub CLI，用于在容器内创建/审查 PR）
RUN DEBIAN_FRONTEND=noninteractive apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        tzdata build-essential xz-utils python3 \
        ca-certificates dnsutils \
        curl git zsh vim gnupg pinentry-curses jq ssh gh

ENV LC_ALL=C.utf8

# 安装 Node.js 24 LTS（当前 Active LTS；dsh 已实测兼容，22 已进入 Maintenance 期）。
# Detect the CPU arch with uname so this works with both docker buildx and podman build.
RUN arch="$(uname -m)" \
    && case "${arch}" in \
         x86_64) node_arch=x64 ;; \
         aarch64|arm64) node_arch=arm64 ;; \
         *) echo "unsupported architecture: ${arch}" >&2; exit 1 ;; \
       esac \
    && curl -fsSL "https://nodejs.org/dist/v24.20.0/node-v24.20.0-linux-${node_arch}.tar.xz" \
      | tar -xJ -C /usr/local --strip-components=1 \
    && node --version \
    && npm --version

# 升级 npm 到最新的 12.x（Node 24 自带的还是 npm 11 线）。
RUN npm install -g npm@12 \
    && npm --version

# pnpm: 现代 TypeScript Web 项目的标准包管理器。
# 不依赖 corepack（Node 官方已弃用并计划移除），直接全局安装当前最新大版本 11。
RUN npm install -g pnpm@11 \
    && pnpm --version

# 安装 DeepSeek Harness
RUN npm install -g @deepseek-ai/dsh \
    && dsh --version

ENV SHELL=/usr/bin/zsh
ENV ZSH=/root/.oh-my-zsh

# 安装 oh-my-zsh
RUN sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)" "" --unattended \
    && git clone --depth=1 https://github.com/zsh-users/zsh-autosuggestions.git "${ZSH_CUSTOM:-$ZSH/custom}/plugins/zsh-autosuggestions" \
    && git clone --depth=1 https://github.com/zsh-users/zsh-syntax-highlighting.git "${ZSH_CUSTOM:-$ZSH/custom}/plugins/zsh-syntax-highlighting"
COPY .zshrc "/root/.zshrc"

COPY entrypoint.sh /entrypoint.sh
CMD ["/entrypoint.sh"]
