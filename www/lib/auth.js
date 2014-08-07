(function () {

	var appId = '524759647625736';
	var hostname = window.location.hostname;
	if (
		(hostname !== 'localhost') &&
		(hostname !== "local.kaiwalya.com") &&
		(hostname !== '0.0.0.0') &&
		(hostname !== "127.0.0.1")) {

		appId = '524756560959378';
	}
	window.fbAsyncInit = function() {
		window.FB.init({
			appId: appId,
			xfbml: false,
			version: 'v2.0'
		});
	};

	(function(d, s, id){
		var js, fjs = d.getElementsByTagName(s)[0];
		if (d.getElementById(id)) {
			return;
		}
		js = d.createElement(s);
		js.id = id;
		js.src = "//connect.facebook.net/en_US/sdk.js";
		fjs.parentNode.insertBefore(js, fjs);
	}(document, 'script', 'facebook-jssdk'));

	var LoginManager = function (loginElement) {
		var This = this;
		This._loginElement = loginElement;
		This._loginElement.addEventListener('click', This._onLoginClicked.bind(This));

		This._status = null;
		This._fbResponseCallback = This._processResponse.bind(This);
		This._init();
	};

	LoginManager.prototype._processResponse = function (response) {
		var This = this;
		console.log(response);
		
		if (response.status === 'connected') {
			This._loginElement.text = This._loginElement.getAttribute("logoutText") || "Logout";
		}
		else {
			This._loginElement.text = This._loginElement.getAttribute("loginText") || "Login"; 
		}
		This._status = response.status;
		This._authResponse = response.authResponse;
	};

	LoginManager.prototype._init = function () {
		var This = this;
		window.FB.getLoginStatus(This._fbResponseCallback);
	};

	LoginManager.prototype._onLoginClicked = function () {
		var This = this;
		if (This._status === 'connected') {
			window.FB.logout(This._fbResponseCallback);
		}
		else {
			window.FB.login(This._fbResponseCallback);
		}
	};

	window.addEventListener('load', function load () {
		window.removeEventListener('load', load);
		new LoginManager(window.document.getElementById("loginButton"));
	});
})();

