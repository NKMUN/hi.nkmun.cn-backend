FROM node:12-alpine
LABEL maintainer="NKMUN <webmaster@nkmun.cn>"

ENV DEFAULT_MONGO="mongodb://mongo/nkmun"
ENV TZ="Asia/Shanghai"
ENV NODE_ENV=production

USER root
WORKDIR /hi-nkmun/

COPY package.json yarn.lock /hi-nkmun/
RUN apk add --no-cache tzdata && \
    cp /usr/share/zoneinfo/${TZ} /etc/localtime && \
    echo ${TZ} > /etc/timezone && \
    apk del tzdata && \
    ( cd /hi-nkmun/ ; yarn install ) && \
    yarn cache clean && rm -rf '/tmp/*'
COPY . /hi-nkmun/

ENTRYPOINT ["/hi-nkmun/bin/hi-nkmun"]
