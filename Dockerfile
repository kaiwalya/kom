FROM knkher/nodejs

ADD . /srv
RUN cd /srv && npm install

EXPOSE 8000

# Run it
ENTRYPOINT ["nodejs", "/srv"]
