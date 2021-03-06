/*
    This is a pseudo engine which provides basic functions for jobManager
    in case jobs are submitted through forks


    engineLayer API contract ::

    engine.list :
        List process running in the engine
        @param None
        @return {Object}jobStatus litteral

        jobStatus litteral Object
        {
            'id' : [],
            'partition' : [],
            'nameUUID' : [],
            'status' : []
        }

    engine.generateHeader :
        Generates the preprocessor instruction required by the engine for any job.
        @param None
        @return {String}job script header lines.

    engine.type :
        Display the type of the engine
        @param None
        @return {String}

    engine.configure :
        Initialize the settings of the engine.
        @param {Object}
        @return null

    engine.submitBin :
        Reference to the execution binary of the engine, it is effectively passed to a job object.
        @param null
        @return {Function}

    engine.kill :
        Terminate processes associated with provided jobs
        @param {Array}List of jobObjects
        @return {Emitter} The following events are exposed
                'cleanExit', noArgs :  all pending jobs were killed
                'leftExit', {Int} nJobs:  number of job left pending");
                'emptyExit', noArgs : No job were to be killed
                'cancelError', {String} message : An error occured during job cancelation
                'listError', {String} message : An error occured during joblisting"
*/

var ps = require('./ps');
var events = require('events');
const path = require('path');
var childProcess = require('child_process');

var workdirEngine = "$PWD"; // to mimic other engines : specify a workdir


/*
* Mimic the other engines
*/
var getPreprocessorString = function(id, profileKey) {
    var string = "";
    // workdir specific to the engine
    string += "WORKDIR=" + workdirEngine + " # cache directory\n";
    return string;
}



/**
* Set scheduler engine and emulation states
*
* @param  {Object}managerOptions: Litteral of options
* @return null
*/
var _psAUX = function() {
    var emitter = new events.EventEmitter();
    var results = {
        'id' : [],
        'partition' : [],
        'nameUUID' : [], // Only mandatory one
        'status' : []
    };
    var regex = /\.batch$/;

    /*
    * This part is implemented to adjust to every type of OS.
    * In fact, GL obtained different results than MG with the following code :
        // dataRecord.forEach(function(d) {
        //     if (d.COMMAND[0] !== 'sh') return;
        //     if (d.COMMAND.length === 1) return;
        //     if (!regex.test(d.COMMAND[1])) return;
        //     var uuid = path.basename(d.COMMAND[1]).replace(".batch", "");
        //     results.id.push(d.PID[0]);
        //     results.partition.push(null);
        //     results.nameUUID.push(uuid);
        //     results.status.push(d.STAT[0]);
        // });
    * For example, key "COMMAND" for GL was "CMD" for MG.
    * The array "COMMAND" contained 2 values for GL, and 3 for MG.
    * 
    * Here a dirty solution : 
    *   (1) @dataRecord is an array of processus in JSON format (@processRecord).
    *       (2) @processRecord is a JSON, each key refers to an array (@processRecord[key]).
    *           (3) @processRecord[key] is an array of string (@ival), in which we search for the regex.
    */
    ps.lookup().on('data', function(dataRecord){
        for (let processRecord of dataRecord) { // (1)
            for (let key in processRecord) { // (2)
                for (let ival of processRecord[key]) { // (3)
                    if (regex.test(ival)) {
                        var uuid = path.basename(ival).replace(".batch", "");
                        results.id.push(processRecord.PID[0]); // dependant from indices so may be bad
                        results.partition.push(null);
                        results.nameUUID.push(uuid);
                        results.status.push(processRecord.STAT[0]); // dependant from indices so may be bad
                    }
                }
            }
        }

        emitter.emit('data', results);
    });
    return emitter;
}


 var killJobs = function (jobObjList) {
    var emitter = new events.EventEmitter();

    var targetJobID = jobObjList.map(function(jobObj) { return jobObj.id;})
    console.log("Potential pending target job ids are:");
    console.dir(targetJobID);

    var targetProcess = [];
    _psAUX()
    .on('listError', function(err) { emitter.emit('killError', err);})
    .on('data', function(psLookupDict){
        psLookupDict.nameUUID.forEach(function(uuid, i) {
            if(targetJobID.indexOf(uuid) >= 0)
                targetProcess.push(psLookupDict.id[i]);
        });
        _kill(targetProcess, emitter);
    });

    emitter.on('finalCount', function() {
        var i = 0;
        _psAUX().on('data', function(psLookupDict){
            psLookupDict.nameUUID.forEach(function(uuid, i) {
                if(targetJobID.indexOf(uuid) >= 0) i++;
            });
            if (i === 0)
                emitter.emit('cleanExit');
            else
                emitter.emit('leftExit', i);
        });
    });

    return emitter;
}

var _kill = function(processIDs, emitter) {
    var exec_cmd = childProcess.exec;
   // console.log('**kill -9 ' + processIDs.join(' '));
    if (processIDs.length == 0) {
        emitter.emit('emptyExit');
        return;
    }
    exec_cmd('kill -9 ' + processIDs.join(' '),
        function (err, stdout, stderr) {
            if (err) {
                //console.log('Error for scancel command : ' + err);
                emitter.emit('cancelError', err);
                return;
            }
            //** redo a count of job

            //console.log('Job kill ');
            emitter.emit('finalCount');
        }
    );

}

/*
    Trying to delegate to engine actual submission
    and output stream set up, or DONT :D
*/

var _nullBin = function (opt) {

    /*var process = spawn('sh', opt.submitArgArray, {
        'cwd': opt.workDir
    });*/
    return null;
}
var _configure = function () {
}

module.exports = {
    list : _psAUX,
    generateHeader : getPreprocessorString,
    type : function () {return "emulator";},
    configure : _configure,
    submitBin : _nullBin,
    //cancelBin : _nullBin, # NOT NEEDED
    kill : killJobs
};