//var xmlParse = require('xml-parser');
var xmlParseString = require('xml2js').parseString;
var events = require('events');
var inspect = require('util').inspect;
var childProcess = require('child_process');
/*
    Scheduler abstraction layer
    Engine=SLURM

    exposes

    dumper(jobObject) Returns a string
    watch : squeue
*/

// SINGLE SCOPE IMPLEMENTATION.
// require me in jobManager scope, pass me to job at creation

var cancelBinary = null;
var queueBinary = null;
var submitBinary = null;

var profiles = require('./sgeProfiles.json');

var nullRe = /<queue_info>[\s]*\n[\s]*<\/queue_info>/;



var qstatFormat = function (qstatRaw) {
    //qstat -xml | tr '\n' ' ' | sed 's#<job_list[^>]*>#\n#g' \
  //| sed 's#<[^>]*>##g' | grep " " | column -t

    //console.log("QSTAT raw content:\n" + qstatRaw);

    if (nullRe.test(qstatRaw)) return [];
    var data = qstatRaw.replace(/\n/g,'').replace(/<job_list[^>]*>/g, "$&\n")
                    .replace(/<[^>]*>/g,'').replace(/^\s*\n/gm, "")
                    .replace(/^[\s]*/gm,"").replace(/[\s]*\n/gm,"\n").split("\n");
    return data.map(function(e){return e.replace(/[\s]*$/g,'').split(/[\s]+/);});
}

/*
#$ -u ifbuser
#$ -wd /home/ifbuser/cacheDir
#$ -N dummy_name_long
#$ -o dummy.out
#$ -e dummy.err
*/


var getPreprocessorString =  function(id, profileKey, workDir) {
    console.log("Generating preprocessor string content");

    if( !profiles.hasOwnProperty("definitions") ) {
         throw("\"profiles\" dictionary is badly formed, no \"definitions\" key");
    }
    if ( !profiles.definitions.hasOwnProperty(profileKey) ) {
        throw("\"" + profileKey + "\" is not a registred SGE profile");
    }
    var string = _preprocessorDump(id, workDir, profiles.definitions[profileKey]);
    //string += _preprocessorDump(id, profiles.definitions[profileKey]);
    console.log(string);

    return string;
}

var preprocessorMapper = {
    user : function (v) {
        return "#$ -u " + v + " #\n"
    },
    workDir : function (v) {
        return "#$ -wd " + v + " #\n"
    },
};

var _preprocessorDump = function(id, workDir, preprocessorOpt) {
    var string = "#$ -N JID_" + id + "\n";
    string += "#$ -wd " + workDir + "\n";
    string += "#$ -o " + id + ".out\n";
    string += "#$ -e " + id + ".err\n";
    for (var opt in preprocessorOpt) {
        if (! preprocessorMapper.hasOwnProperty(opt)) {
            console.warn("\"" + opt + "\" is not known profile parameters\"");
            continue;
        }
        string += preprocessorMapper[opt](preprocessorOpt[opt]);
    }

    return string;
}



/**  A REECRIRE jobsArray does not exist in this space.
* List all the job ids of slurm that are both in this process and in the squeue command.
* Only used in the stop function.
* Warning : the ids or not listed in order.
*/
var _listSlurmJobID = function(tagTask) {
    var emitter = new events.EventEmitter();
    console.log("SGE job Listing");
    // run squeue command
    var exec_cmd = childProcess.exec;
    exec_cmd(queueBinary + ' -f', function (err, stdout, stderr) {
        if (err) {
            emitter.emit('listError', err);
            return;
        }
        console.log(stdout);
        // list of slurmIDs of the jobs to kill
        var toKill = new Array();

        // squeue results
        var squeueIDs = ('' + stdout).replace(/\"/g, '');
        // regex
        var reg_NslurmID = new RegExp ('^' + tagTask + 'Task_[\\S]{8}-[\\S]{4}-[\\S]{4}-[\\S]{4}-[\\S]{12}_{0,1}[\\S]*');
        var reg_slurmID = new RegExp ('[0-9]+$');
        //console.log(squeueIDs);

        // for each job in the squeue
        squeueIDs.split('\n').forEach (function (line) {
            // use the regex
            if (reg_NslurmID.test(line) && reg_slurmID.test(line)) {
                var NslurmID = reg_NslurmID.exec(line);
                var slurmID = reg_slurmID.exec(line);
                // in case we found NslurmID in the jobs of our process
                if (jobsArray.hasOwnProperty(NslurmID)) {
                    console.log('Job ' + slurmID + ' must be killed');
                    toKill.push(slurmID[0]);
                }
            }
        });
        if (toKill.length === 0) emitter.emit('finished');
        else emitter.emit('jobLeft', toKill);
    });
    return emitter;
}

var createJobTemplate = function(jobOpt) {
    return {
            'batch' : submitBinary,
            'id' : 'id' in jobOpt ? jobOpt.id : null,
            'uid' : 'uid' in jobOpt ? jobOpt.uid : null,
            /*'cwd' : 'cwd' in jobOpt ? jobOpt.cwd : null,
            'cwdClone' : 'cwdClone' in jobOpt ? jobOpt.cwdClone : false,*/
            'cmd' : 'cmd' in jobOpt ? jobOpt.cmd : null,
            'script' : 'script' in jobOpt ? jobOpt.script : null,
            'exportVar' : 'exportVar' in jobOpt ? jobOpt.exportVar : null,
            /*
            'nNodes' : 'nNodes' in jobOpt ? jobOpt.nNodes : null,
            'nCores' : 'nCores' in jobOpt ? jobOpt.nCores : null,
            'modules' : 'modules' in jobOpt ? jobOpt.modules : null,
            */
            };
}


/*
* Realize an asynchronous squeue command on slurm according a parameter (or not).
* Results are then filtered to keep only jobs contained in our jobsArray{}.
* Finally, datas are formated into a literal.
* @paramSqueue {string} optional. For example : ' -o "%j %i" ' // not implemented yet
*/
var _qstat = function(qstatParam) {

    if (! qstatParam) qstatParam = '';
    qstatParam = ''; // to remove when it will be take into account in the implementation
    var emitter = new events.EventEmitter();
    var qstatResDict = {
        'id' : [],
        'partition' : [],
        'nameUUID' : [],
        'status' : []
    }

    // squeue command
    var exec_cmd = childProcess.exec;
    var cmd = queueBinary + ' -xml ';

    exec_cmd(cmd, function (err, stdout, stderr) {
        if (err){
            console.log("qstat error");
            emitter.emit('listError', err);
            return;
        }
        qstatFormat(stdout).forEach(function(e,i) {
            qstatResDict.id.push( e[0] ); // job ID gived by scheduler
            qstatResDict.partition.push(e[6]); // gpu, cpu, etc.
            qstatResDict.nameUUID.push(e[2].replace("JID_", "")); // unique job ID gived by jobManager (uuid)
            qstatResDict.status.push(e[4]); // P, R, CF, CG, etc.
        });
        emitter.emit('data', qstatResDict);
    });
    return emitter;
}




var squeueReport = function() {
    var emitter = new events.EventEmitter();
    var squeueRes;
    _qstat().on('data', function(d) {
         // to return with the event 'end' :
         var interface = {
             data: d,

                 /*
                  * Search for all jobs running on a given @partition
                  * @partition must be the name of a partition or a part of the name
                  * (match method is used instead of ===)
                  */
                 matchPartition: function(partition) {
                     var self = this;
                     var results = {
                         'id': [],
                         'partition': [],
                         'nameUUID': [],
                         'status': []
                     };
                     self.data.partition.map(function(val, i) { // for each partition
                         if (val.match(partition)) { // if the job is on @partition
                             for (var key in self.data) { // keep all the {'key':'value'} corresponding
                                 results[key].push(self.data[key][i]);
                             }
                         }
                     });
                     return results;
                 }
         };
         emitter.emit('end', interface);
     }).on('listError', function(err) {
         console.log('ERROR with _squeue() method in nslurm : ');
         console.log(err);
         emitter.emit('errSqueue');
     });
     return emitter;
 }

/*
//KILL JOBS,_kill to keep on DVL
Params:
*/
 var killJobs = function (jobObjList) {
    var emitter = new events.EventEmitter();

    var targetJobID = jobObjList.map(function(jobObj) { return jobObj.id;})
    console.log("Potential pending target job ids are:");
    console.dir(targetJobID);

    var targetProcess = [];
    _qstat()
    .on('listError', function(err) { emitter.emit('killError', err);})
    .on('data', function(qstatResDict) {
        qstatResDict.nameUUID.forEach(function(uuid, i) {
            if( targetJobID.indexOf(uuid) >= 0 )
                targetProcess.push(qstatResDict.id[i]);
        });
        console.log("Target process ids are " + targetProcess);
        _kill(targetProcess, emitter);
    });

    return emitter;
}

var _kill = function(processIDs, emitter) {
    var exec_cmd = childProcess.exec;
    if (processIDs.length == 0) {
        emitter.emit('emptyExit');
        return;
    }

    exec_cmd(cancelBinary + ' ' + processIDs.join(' '), function(err, stdout, stderr) {
        if (err) {
            emitter.emit('cancelError', err);
            return;
        }
        //final recount
        setTimeout(function() {
            _qstat().on('data', function(qstatLookupDict) {
                var nLeft = 0;
                qstatLookupDict.id.forEach(function(pid, i) {
                    if (processIDs.indexOf(pid) >= 0)
                        nLeft++;
                });
                if (nLeft == 0)
                    emitter.emit('cleanExit');
                else
                    emitter.emit('leftExit', nLeft);

            });
        }, 2000);
    });
}
module.exports = {
    configure : function(opt) {
        console.log("configuring engine binaries");
        if (opt.hasOwnProperty("cancelBin"))
            cancelBinary = opt["cancelBin"];
        if (opt.hasOwnProperty("queueBin"))
            queueBinary = opt["queueBin"];
        if (opt.hasOwnProperty("submitBin"))
            submitBinary = opt["submitBin"];
        console.log("SGE Binaries set to ::\ncancel : " + cancelBinary + '\nqueue : ' + queueBinary + '\nsubmit : ' + submitBinary);
    },
    //createJobTemplate : createJobTemplate,
    generateHeader : getPreprocessorString,
    list : _qstat,
    cancelBin : function() { return cancelBinary;},
    submitBin : function() { return submitBinary;},
    type : function () {return 'sge';},
    kill : killJobs
};

