FROM ubuntu:14.04

ADD . /srv

RUN apt-get update
RUN apt-get install -y nodejs
RUN apt-get install -y npm
RUN cd /srv && npm install

EXPOSE 8000

# Run it
ENTRYPOINT ["nodejs", "/srv"]
