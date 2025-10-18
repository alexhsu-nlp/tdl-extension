# Base image
FROM ubuntu:24.04

# Prevent interactive prompts (e.g. tzdata)
ENV DEBIAN_FRONTEND=noninteractive

# Install base system tools and dependencies required by VS Code + repos
RUN apt-get update && apt-get install -y \
    sudo \
    curl \
    wget \
    gpg \
    ca-certificates \
    apt-transport-https \
    software-properties-common \
    git \
    bash-completion \
    && rm -rf /var/lib/apt/lists/*

# Create a non-root user
RUN useradd -m dockeruser && echo "dockeruser ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers

USER dockeruser
# NOTE: type your own directory here
# WORKDIR /path/to/your/extension/directory
COPY . .

RUN sudo apt-get update && \
    # Clean up apt list files
    sudo rm -rf /var/lib/apt/lists/*

# Install NVM + Node.js (LTS)  
ENV NVM_DIR="/home/dockeruser/.nvm"
RUN curl -sL https://raw.githubusercontent.com/nvm-sh/nvm/v0.35.0/install.sh -o install_nvm.sh && \
    bash install_nvm.sh && \
    rm install_nvm.sh && \
    # Use bash to load nvm and install LTS
    bash -c "export NVM_DIR=$NVM_DIR && \
    [ -s \"$NVM_DIR/nvm.sh\" ] && . \"$NVM_DIR/nvm.sh\" && \
    nvm install --lts && \
    nvm alias default lts/* && \
    npm install"

# Copy the rest of your source files
COPY . .

# Compile your extension
RUN bash -c "export NVM_DIR=$NVM_DIR && \
    [ -s \"$NVM_DIR/nvm.sh\" ] && . \"$NVM_DIR/nvm.sh\" && \
    npm run compile"

# Ensure nvm is loaded in new shells
RUN echo 'export NVM_DIR="$HOME/.nvm"' >> ~/.bashrc && \
    echo '[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"' >> ~/.bashrc && \
    echo '[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"' >> ~/.bashrc

# Default shell
CMD ["/bin/bash"]
