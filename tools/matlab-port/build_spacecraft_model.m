function modelPath=build_spacecraft_model(outputDirectory,config,definition)
%BUILD_SPACECRAFT_MODEL Build a runnable native RCS -> 6-DOF Simulink model.
% Inputs are valve requests and faults, never prerecorded spacecraft states.
root=fileparts(mfilename('fullpath'));
if nargin<1 || isempty(outputDirectory), outputDirectory=fullfile(root,'output'); end
if nargin<2 || isempty(config), [config,fixtures]=docking.loadReference();
else, [~,fixtures]=docking.loadReference(); end
if nargin<3 || isempty(definition), definition=fixtures.cases.nominal; end
if isempty(which('new_system')) || ~license('test','Simulink')
    error('docking:SimulinkUnavailable','Simulink is required to build this model');
end
if ~isfolder(outputDirectory), mkdir(outputDirectory); end
[commands,faults]=docking.pulseInputs(definition,config);
config.runTicks=definition.ticks;
config.initial.time_s=definition.startTime_s;
model='dragon_sixdof'; modelPath=fullfile(outputDirectory,[model '.slx']);
if bdIsLoaded(model)
    assert(strcmp(get_param(model,'Dirty'),'off'),'Save or close your edited dragon_sixdof model first');
    close_system(model,0);
end
load_system('simulink'); new_system(model);
cleanup=onCleanup(@()closeModel(model)); %#ok<NASGU>
set_param(model,'Solver','FixedStepDiscrete','FixedStep',num2str(config.dt_s,17), ...
    'StartTime','0','StopTime',num2str(definition.ticks*config.dt_s,17), ...
    'SimulationMode','normal','ReturnWorkspaceOutputs','on');
workspace=get_param(model,'ModelWorkspace');
assignin(workspace,'modelParams',config);
assignin(workspace,'commandInput',commands);
assignin(workspace,'faultInput',faults);
add_block('simulink/Sources/From Workspace',[model '/Valve pulse requests'], ...
    'VariableName','commandInput','Interpolate','off','OutputAfterFinalValue','Holding final value','SampleTime',num2str(config.dt_s,17), ...
    'Position',[35 70 190 110]);
add_block('simulink/Sources/From Workspace',[model '/Fault injection'], ...
    'VariableName','faultInput','Interpolate','off','OutputAfterFinalValue','Holding final value','SampleTime',num2str(config.dt_s,17), ...
    'Position',[35 155 190 195]);
add_block('simulink/User-Defined Functions/Level-2 MATLAB S-Function', ...
    [model '/RCS geometry and fuel'], 'FunctionName','sfun_docking_rcs', ...
    'Parameters','modelParams','Position',[315 75 510 205]);
add_block('simulink/User-Defined Functions/Level-2 MATLAB S-Function', ...
    [model '/Spacecraft 6DOF RK4'], 'FunctionName','sfun_docking_sixdof', ...
    'Parameters','modelParams','Position',[650 100 845 190]);
add_block('simulink/Sinks/To Workspace',[model '/Truth state log'], ...
    'VariableName','truthLog','SaveFormat','Timeseries','MaxDataPoints','inf', ...
    'Position',[1020 85 1160 125]);
add_block('simulink/Sinks/To Workspace',[model '/Applied acceleration torque fuel'], ...
    'VariableName','actuatorLog','SaveFormat','Timeseries','MaxDataPoints','inf', ...
    'Position',[640 290 850 335]);
% Resolve Level-2 S-function port counts before referring to ports 2 and 3.
set_param(model,'SimulationCommand','update');
connect(model,'Valve pulse requests/1','RCS geometry and fuel/1','on-time per jet [s]');
connect(model,'Fault injection/1','RCS geometry and fuel/2','jet fault states');
connect(model,'RCS geometry and fuel/1','Spacecraft 6DOF RK4/1','a_B [m/s^2], tau_B [Nm], fuel [kg/s]');
connect(model,'Spacecraft 6DOF RK4/1','Truth state log/1','r_H, v_H, q_BI, omega_B, prop');
connect(model,'Spacecraft 6DOF RK4/2','RCS geometry and fuel/3','remaining propellant [kg]');
connect(model,'RCS geometry and fuel/1','Applied acceleration torque fuel/1','');
set_param(model,'Location',[80 80 1350 650]);
save_system(model,modelPath);
end
function connect(model,source,dest,label)
h=add_line(model,source,dest,'autorouting','on');
if ~isempty(label), set_param(h,'Name',label); end
end
function closeModel(model)
if bdIsLoaded(model), close_system(model,0); end
end
