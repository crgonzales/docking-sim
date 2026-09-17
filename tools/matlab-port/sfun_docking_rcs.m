function sfun_docking_rcs(block)
%SFUNRCS Executable actuator geometry, faults, mass and fuel exhaustion.
block.NumDialogPrms=1;
block.DialogPrmsTunable={'Nontunable'};
block.NumInputPorts=3;
block.NumOutputPorts=1;
block.SetPreCompInpPortInfoToDynamic;
block.SetPreCompOutPortInfoToDynamic;
count=numel(block.DialogPrm(1).Data.specs);
widths=[count,count,1];
for k=1:3
    block.InputPort(k).Dimensions=widths(k);
    block.InputPort(k).DatatypeID=0;
    block.InputPort(k).Complexity='Real';
    block.InputPort(k).DirectFeedthrough=true;
end
block.OutputPort(1).Dimensions=7;
block.OutputPort(1).DatatypeID=0;
block.OutputPort(1).Complexity='Real';
block.SampleTimes=[block.DialogPrm(1).Data.dt_s 0];
block.SimStateCompliance='DefaultSimState';
block.RegBlockMethod('Outputs',@outputs);
end
function outputs(block)
config=block.DialogPrm(1).Data;
config.window_s=config.dt_s;
config.minOnTime_s=0; % whole command already passed the minimum-pulse rule
config.prop_kg=block.InputPort(3).Data;
codes=block.InputPort(2).Data;
assert(all(isfinite(codes)) && all(codes==floor(codes)) && all(codes>=0 & codes<=3), ...
    'Invalid RCS fault codes');
labels={'nominal','isolated','stuck_open','stuck_closed'};
config.states=struct();
for k=1:numel(config.specs)
    config.states.(config.specs(k).id)=labels{codes(k)+1};
end
application=docking.applyThrusters(block.InputPort(1).Data,config);
block.OutputPort(1).Data=[application.specificForce_body_mps2; ...
    application.torque_Nm;application.propellantRate_kg_s];
end
