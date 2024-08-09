#FROM ${registry:-registry.cn-chengdu.aliyuncs.com}/zpcloud/zoomphant-base:1.0
FROM ubuntu:22.04

MAINTAINER ZoomPhant DEV <dev@zoomphant.com>

LABEL name="ZoomPhant JS Agent" \
    vendor="ZoomPhant"

# Please change this to your servie name
ARG svcName=zoomphant-js-agent
ARG svcDescr="Zoomphant Javascript Agent"

LABEL name=$svcDescr \
    vendor="ZoomPhant"


ENV APP_BASE=/usr/local/zoomphant

RUN apt-get update

# install basic tools ...
# RUN apt-get install -y wget bind-utils which net-tools telnet iproute traceroute nc vim
RUN apt-get install -y wget curl net-tools telnet traceroute vim

# install python, looks npm stuff need to have python ...
RUN apt-get install -y python3 make g++

# install chrome
# RUN wget -O /tmp/google-chrome.rpm https://dl.google.com/linux/direct/google-chrome-stable_current_x86_64.rpm
# RUN dnf install /tmp/google-chrome.rpm -y
# RUN rm /tmp/google-chrome.rpm
RUN wget -O /tmp/google-chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
RUN apt install /tmp/google-chrome.deb -y
RUN rm /tmp/google-chrome.deb

# install nodejs & npm
ENV NVM_DIR /usr/local/nvm
ENV NODE_VERSION 20.10.0

RUN mkdir -p $NVM_DIR

# Install nvm with node and npm
RUN curl https://raw.githubusercontent.com/creationix/nvm/v0.39.7/install.sh | bash \
    && . $NVM_DIR/nvm.sh \
    && nvm install $NODE_VERSION \
    && nvm alias default $NODE_VERSION \
    && nvm use default
ENV NODE_PATH $NVM_DIR/v$NODE_VERSION/lib/node_modules
ENV PATH      $NVM_DIR/versions/node/v$NODE_VERSION/bin:$PATH

# RUN yum install -y libcurl-devel
RUN apt-get install -y libcurl4-openssl-dev

RUN mkdir -p $APP_BASE/agent

WORKDIR $APP_BASE/agent

# Install lighthouse for testing purpose
RUN npm install -g lighthouse

# Install pm2
# RUN npm install pm2 -g

COPY ./package.json ./
RUN npm install --unsafe-perm

COPY ./libs ./libs
COPY ./src ./src
# COPY ./test ./test
COPY ./plugins ./plugins
COPY ./index.js ./

COPY ./docker/dumb-init /usr/bin/
RUN chmod +x /usr/bin/dumb-init

#
# Looks below won't run our service using created user, so what to do?
## RUN useradd -ms /bin/bash zoomphant
## USER zoomphant

ENTRYPOINT ["/usr/bin/dumb-init", "--"]

# Start agent
# CMD ["pm2-runtime", "start", "index.js", "--name=jsagent"]
CMD ["node", "index.js"]
