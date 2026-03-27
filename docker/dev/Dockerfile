FROM node:24-bookworm

ENV DEBIAN_FRONTEND=noninteractive
ENV NPM_CONFIG_PREFIX=/home/node/.npm-global
ENV PATH=/home/node/.local/bin:/home/node/.npm-global/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

RUN apt-get update && apt-get install -y \
  bash \
  bubblewrap \
  ca-certificates \
  curl \
  ffmpeg \
  git \
  gh \
  jq \
  less \
  openssh-client \
  passwd \
  procps \
  python3 \
  ripgrep \
  sqlite3 \
  tmux \
  unzip \
  vim \
  && rm -rf /var/lib/apt/lists/*

COPY --chown=node:node docker/dev/entrypoint.sh /usr/local/bin/devbox-entrypoint.sh
RUN chmod +x /usr/local/bin/devbox-entrypoint.sh

USER node
WORKDIR /home/node/workspace

RUN mkdir -p /home/node/.local/bin /home/node/.npm-global \
  && echo 'export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"' >> /home/node/.bashrc

RUN npm install -g @openai/codex opencode-ai@latest
RUN curl -fsSL https://claude.ai/install.sh | bash

ENTRYPOINT ["/usr/local/bin/devbox-entrypoint.sh"]
CMD ["/bin/bash"]
