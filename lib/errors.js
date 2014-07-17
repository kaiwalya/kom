
exports.errorFromCode = function (code, message) {
	var err = {
		statusCode: code,
		entity: message
	};

	return err;
};

exports.errorFromError = function (errObj) {
	return {
		statusCode: 500,
		entity: errObj.name + ": " + errObj.message
	};
};
