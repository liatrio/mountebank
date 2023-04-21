# syntax=docker/dockerfile:1

FROM node:18-alpine

RUN apk update
RUN apk upgrade

WORKDIR /app

# Install tarball to allow the command to be 'mb' instead of 'bin/mb'
COPY ./ ./
RUN npm install --production && npm cache clean -f

# Run as a non-root user
RUN adduser -D mountebank
RUN chown -R mountebank /app
USER mountebank

EXPOSE 2525 5555

ENTRYPOINT ["node", "bin/mb", "--allow-injection"]
