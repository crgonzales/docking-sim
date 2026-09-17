function [commands,faults]=pulseInputs(definition,config)
%PULSEINPUTS Convert raw 10 Hz valve requests into timestamped 100 Hz slices.
% No reference truth is read. Numeric arrays are [relative_time, jet values].
N=definition.ticks; dt=config.dt_s; J=numel(config.specs);
assert(N>0 && N==floor(N),'Pulse experiment requires positive integer ticks');
assert(config.ticksPerWindow==round(config.window_s/dt),'Inconsistent command/truth rates');
times=(0:N)'*dt;
commands=[times,zeros(N+1,J)]; faults=commands;
codes=zeros(1,J); remaining=zeros(J,1); eventIndex=1;
for tick=1:N
    while eventIndex<=numel(definition.events) && definition.events(eventIndex).tick==tick
        event=definition.events(eventIndex);
        j=find(strcmp({config.specs.id},event.thrusterId),1);
        assert(~isempty(j),'Unknown fault thruster');
        if strcmp(event.kind,'STUCK_OPEN'), codes(j)=2;
        elseif strcmp(event.kind,'ISOLATE'), codes(j)=1;
        else, error('Unsupported fault event'); end
        remaining(j)=0; eventIndex=eventIndex+1;
    end
    if mod(tick-1,config.ticksPerWindow)==0
        request=definition.commands(floor((tick-1)/config.ticksPerWindow)+1).requestedOnTime_s;
        values=zeros(J,1);
        for j=1:J
            if isfield(request,config.specs(j).id), values(j)=request.(config.specs(j).id); end
        end
        quantized=docking.applyThrusters(values,config);
        remaining=quantized.quantizedOnTime_s;
    end
    remaining(codes~=0)=0;
    commands(tick,2:end)=min(dt,remaining)';
    faults(tick,2:end)=codes;
    remaining=max(0,remaining-dt);
end
faults(end,2:end)=codes;
end
