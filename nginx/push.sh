scp -r ./nginx kom:/home/k
echo 'sudo cp -r nginx/* /etc/nginx/' | ssh kom
echo 'rm -rf /home/k/nginx' | ssh kom
echo 'sudo /etc/init.d/nginx reload' | ssh kom


