#FROM ${registry:-registry.cn-chengdu.aliyuncs.com}/zpcloud/zoomphant-base:1.0
FROM browserless/chrome:latest

MAINTAINER ZoomPhant DEV <dev@zoomphant.com>

LABEL name="ZoomPhant JS Agent" \
vendor="ZoomPhant"

# Please change this to your servie name
ARG svcName=zoomphant-js-agent
ARG svcDescr="Zoomphant Javascript Agent"

LABEL name=$svcDescr \
vendor="ZoomPhant"


# Switch to root user
USER root

ENV APP_BASE=/usr/local/zoomphant

RUN apt-get update

# install basic tools ...
# RUN apt-get install -y wget bind-utils which net-tools telnet iproute traceroute nc vim
RUN apt-get install -y wget curl net-tools telnet traceroute vim

# RUN yum install -y libcurl-devel
RUN apt-get install -y libcurl4-openssl-dev

RUN mkdir -p $APP_BASE/agent

WORKDIR $APP_BASE/agent

# Install pm2
# RUN npm install pm2 -g

COPY ./package.json ./
RUN npm install --unsafe-perm

COPY ./libs ./libs
COPY ./src ./src

COPY ./plugins ./plugins
COPY ./index.js ./

RUN apt-get -qq clean && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/* /usr/share/fonts/truetype/noto

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
