function sfun_docking_sixdof(block)
%SFUNSIXDOF Native 100 Hz RK4 plant; state outputs precede each update.
block.NumDialogPrms=1;
block.DialogPrmsTunable={'Nontunable'};
block.NumInputPorts=1;
block.NumOutputPorts=2;
block.SetPreCompInpPortInfoToDynamic;
block.SetPreCompOutPortInfoToDynamic;
block.InputPort(1).Dimensions=7; % [a_body(3); torque_body(3); mdot]
block.InputPort(1).DatatypeID=0;
block.InputPort(1).DirectFeedthrough=false;
block.OutputPort(1).Dimensions=14;
block.OutputPort(2).Dimensions=1; % current propellant, fed back to actuators
for k=1:2
    block.OutputPort(k).DatatypeID=0;
    block.OutputPort(k).Complexity='Real';
end
block.SampleTimes=[block.DialogPrm(1).Data.dt_s 0];
block.SimStateCompliance='DefaultSimState';
block.RegBlockMethod('PostPropagationSetup',@configureState);
block.RegBlockMethod('InitializeConditions',@initialize);
block.RegBlockMethod('Outputs',@outputs);
block.RegBlockMethod('Update',@update);
end
function configureState(block)
block.NumDworks=1;
block.Dwork(1).Name='truth';
block.Dwork(1).Dimensions=14;
block.Dwork(1).DatatypeID=0;
block.Dwork(1).Complexity='Real';
block.Dwork(1).UsedAsDiscState=true;
end
function initialize(block)
block.Dwork(1).Data=block.DialogPrm(1).Data.initial.state(:);
end
function outputs(block)
state=block.Dwork(1).Data;
block.OutputPort(1).Data=state;
block.OutputPort(2).Data=state(14);
end
function update(block)
config=block.DialogPrm(1).Data;
tick=round(block.CurrentTime/config.dt_s);
if tick>=config.runTicks, return; end % exactly N integrations for N+1 samples
u=block.InputPort(1).Data;
options=struct('meanMotionRadS',config.meanMotionRadS, ...
    'inertia_kg_m2',config.inertia_kg_m2, ...
    'externalSpecificForce_body_mps2',u(1:3), ...
    'torque_body_Nm',u(4:6),'propellantRate_kg_s',u(7));
t=config.initial.time_s+tick*config.dt_s;
block.Dwork(1).Data=docking.stepTruth(block.Dwork(1).Data,config.dt_s,t,options);
end
