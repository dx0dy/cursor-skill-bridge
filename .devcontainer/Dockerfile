FROM mcr.microsoft.com/devcontainers/javascript-node:24-trixie@sha256:7e6eff9f0cac7f1d4d1836a7bd2a9011d8ea244fceb155261705be483218ea18

ARG WORKSPACE_FOLDER_BASENAME
WORKDIR /workspaces/${WORKSPACE_FOLDER_BASENAME}

USER node

RUN mkdir -p /workspaces/${WORKSPACE_FOLDER_BASENAME}/node_modules
RUN chown -R node:node /workspaces/${WORKSPACE_FOLDER_BASENAME}/node_modules
COPY --chown=node ../package.json ../package-lock.json /workspaces/${WORKSPACE_FOLDER_BASENAME}/
RUN npm ci
