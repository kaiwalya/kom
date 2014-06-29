var http = require('http');
http.createServer(function (req, res) {
  res.writeHead(200, {'Content-Type': 'text/plain'});
  var n = 10;
  var sleepTime = 1000;
  var replySome = function () {
  	n--;
  	var msg = 'Hello World ' + n + "\n"
  	if (n > 0) {
  		res.write(msg);
  		setTimeout(replySome, sleepTime);
  	}
  	else {
  		res.end(msg);
  	}
  };

  setTimeout(replySome, sleepTime);

}).listen(8000, '0.0.0.0');
console.log('Server running at http://0.0.0.0:8000/');
