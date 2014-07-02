kaiwalya.com
===

Running Locally
---

To Run locally...

1. Install Docker
2. <code>docker run -p 8000:8000  knkher/web</code>

View the website @ localhost:8000 in the browser.

If you are running in osx with boot2docker. Use <code>boot2docker ip</code> to find the ip address of the machine running docker and use that instead of </code>localhost</code> above.

Running on AWS
---

The package is in a format which directly works with AWS Elasticbean stalk. For deployment to work correctly the archive uploaded to AWS Elastic Beanstalk needs to contain Dockerfile and Dockerrun.aws.json in the root. This is the reason tar.gz and zip directly from github will not work (since they introduce an extra folder level in the zipfile)


Docker Images
---
<code>dockerimages/nodejs/Dockerfile</code> contains the base image. Its main purpose is that it allows for faster deployments on AWS otherwise the <code>apt-get install</code> run lines take forever.

<code>Dockerfile</code> mounts the local files into <code>/srv</code>. Then does the <code>npm install</code> for this package and sets <code>nodejs /srv</code> as the entrypoint for the docker image.






