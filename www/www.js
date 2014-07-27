(function (angular) {
	var app = angular.module('www', ['ngRoute']);

	app.config(["$locationProvider", "$routeProvider", function ($locationProvider, $routeProvider) {
		$locationProvider.html5Mode(true);
		$routeProvider
			.when("/app/aboutme", {
				templateUrl: "/aboutme/index.html"
			})
			.when("/app/aboutsite", {
				templateUrl: "/aboutsite/index.html"
			})
			.when("/app/projects", {
				templateUrl: "/projects/index.html"
			})
			.otherwise({
				redirectTo: "/app/aboutme"
			});
	}]);

})(window.angular);