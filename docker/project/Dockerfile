FROM node:24.14.1-bookworm

ARG ORC_UID=1000
ARG ORC_GID=1000
ENV DEBIAN_FRONTEND=noninteractive
ENV HOME=/home/node
ENV ORC_PROJECT_DIR=/workspace/project
ENV ORC_STATE_DIR=/workspace/project/.orc-state
ENV ORC_HOME=/workspace/project
ENV ORC_REPO_ROOT=/workspace/project

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash ca-certificates curl git gh jq openssh-client procps python3 ripgrep sqlite3 tmux \
  && rm -rf /var/lib/apt/lists/* \
  && (getent group "$ORC_GID" >/dev/null || groupmod -g "$ORC_GID" node) \
  && usermod -u "$ORC_UID" -g "$ORC_GID" node

# Provider binaries live in the image; credentials live only in the project-home volume.
RUN npm install -g \
    @anthropic-ai/claude-code@2.1.308 \
    @openai/codex@0.163.0 \
    @google/gemini-cli@0.65.0

WORKDIR /opt/orc-state
COPY --chown=node:node . .
RUN npm ci && npm run build && npm prune --omit=dev \
  && ln -s /opt/orc-state/dist/cli/orc.js /usr/local/bin/orc \
  && install -m 0755 docker/project/entrypoint.sh /usr/local/bin/orc-project-entrypoint \
  && install -m 0755 docker/project/preflight.sh /usr/local/bin/orc-project-preflight

RUN mkdir -p /workspace/project/.orc-state /home/node \
  && chown -R node:node /workspace /home/node /opt/orc-state

USER node
WORKDIR /workspace/project
ENTRYPOINT ["/usr/local/bin/orc-project-entrypoint"]
