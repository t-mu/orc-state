FROM node:24-bookworm

ARG USERNAME=dev
ARG USER_UID=1000
ARG USER_GID=1000

ENV DEBIAN_FRONTEND=noninteractive
ENV PATH=/home/${USERNAME}/.local/bin:/home/${USERNAME}/.npm-global/bin:/usr/local/bin:/usr/bin:/bin

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
  sudo \
  tmux \
  unzip \
  vim \
  && rm -rf /var/lib/apt/lists/*

RUN groupadd --gid ${USER_GID} ${USERNAME} \
  && useradd --uid ${USER_UID} --gid ${USER_GID} -m -s /bin/bash ${USERNAME} \
  && echo "${USERNAME} ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/${USERNAME} \
  && chmod 0440 /etc/sudoers.d/${USERNAME}

USER ${USERNAME}
WORKDIR /home/${USERNAME}/workspace

RUN mkdir -p /home/${USERNAME}/.local/bin /home/${USERNAME}/.npm-global \
  && npm config set prefix /home/${USERNAME}/.npm-global \
  && echo 'export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"' >> /home/${USERNAME}/.bashrc

RUN npm install -g @openai/codex opencode
RUN curl -fsSL https://claude.ai/install.sh | bash

CMD ["/bin/bash"]
