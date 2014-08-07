/**
 * New Relic agent configuration.
 *
 * See lib/config.defaults.js in the agent distribution for a more complete
 * description of configuration variables and their potential values.
 */
exports.config = {
  /**
   * Array of application names.
   */
  app_name : ['kaiwalya.com'],
  /**
   * Your New Relic license key.
   */
  license_key : '5bcf7bc1f5233de77be4339d6450590f442d0942',
  logging : {
    /**
     * Level at which to log. 'trace' is most useful to New Relic when diagnosing
     * issues with the agent, 'info' and higher will impose the least overhead on
     * production applications.
     */
    level : 'info'
  }
};


process.env.NEW_RELIC_HOME = __dirname;

require("newrelic");
