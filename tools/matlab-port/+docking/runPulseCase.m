function result = runPulseCase(caseDefinition, config)
%RUNPULSECASE Integrate a fixture's 10 Hz commands as 100 Hz slices.
% result = docking.runPulseCase(caseDefinition, config)
% returns result.time_s (1xN+1), result.states (14xN+1), and one result
% application entry per completed truth tick. The first sample is the
% unmodified initial state; sample k is after k integrations.

if nargin < 2 || isempty(config)
    [config, fixtures] = docking.loadReference();
    if nargin < 1 || isempty(caseDefinition), caseDefinition = fixtures.cases.nominal; end
end
if isfield(config, 'config'), config = config.config; end
if ~isstruct(caseDefinition) || ~isfield(caseDefinition, 'commands') || ~isfield(caseDefinition, 'ticks')
    error('docking:InvalidCase', 'caseDefinition must contain commands and ticks.');
end
dt = config.dt_s;
ticksPerWindow = config.ticksPerWindow;
if caseDefinition.ticks < 0 || mod(caseDefinition.ticks, 1) ~= 0 || ticksPerWindow < 1
    error('docking:InvalidCase', 'case ticks and ticksPerWindow must be positive integers.');
end
if isfield(caseDefinition, 'dt_s') && abs(caseDefinition.dt_s - dt) > 1e-15
    error('docking:InvalidCase', 'case dt_s does not match the loaded config.');
end
startTime = config.initial.time_s;
if isfield(caseDefinition, 'startTime_s')
    startTime = caseDefinition.startTime_s;
end
if ~isscalar(startTime) || ~isfinite(startTime)
    error('docking:InvalidCase', 'case startTime_s must be finite.');
end
specs = config.specs;
count = numel(specs);
state = config.initial.state(:);
time = startTime;
states = zeros(14, caseDefinition.ticks + 1);
times = zeros(1, caseDefinition.ticks + 1);
states(:, 1) = state;
times(1) = time;
applications = repmat(emptyApplication(count), 1, caseDefinition.ticks);
faults = struct();
remaining = zeros(count, 1);
events = caseDefinition.events;
eventIndex = 1;

for tick = 1:caseDefinition.ticks
    while eventIndex <= numel(events) && events(eventIndex).tick == tick
        event = events(eventIndex);
        if strcmp(event.kind, 'STUCK_OPEN')
            faults.(event.thrusterId) = 'stuck_open';
        elseif strcmp(event.kind, 'ISOLATE')
            faults.(event.thrusterId) = 'isolated';
        else
            error('docking:InvalidCaseEvent', 'Unsupported pulse-case event: %s', event.kind);
        end
        index = find(strcmp({specs.id}, event.thrusterId), 1);
        if isempty(index), error('docking:UnknownThruster', 'Unknown event thruster: %s', event.thrusterId); end
        remaining(index) = 0;
        eventIndex = eventIndex + 1;
    end
    if mod(tick - 1, ticksPerWindow) == 0
        window = caseDefinition.commands((tick - 1) / ticksPerWindow + 1);
        remaining = fieldVector(window.quantizedOnTime_s, specs);
    end
    command = min(dt, remaining);
    for index = 1:count
        stateName = stateAt(faults, specs(index).id);
        if ~strcmp(stateName, 'nominal'), command(index) = 0; end
    end
    sliceConfig = config;
    sliceConfig.states = faults;
    sliceConfig.prop_kg = state(14);
    sliceConfig.window_s = dt;
    sliceConfig.minOnTime_s = 0;
    applications(tick) = docking.applyThrusters(command, sliceConfig);
    options = struct('meanMotionRadS', config.meanMotionRadS, ...
        'inertia_kg_m2', config.inertia_kg_m2, ...
        'externalSpecificForce_body_mps2', applications(tick).specificForce_body_mps2, ...
        'torque_body_Nm', applications(tick).torque_Nm, ...
        'propellantRate_kg_s', applications(tick).propellantRate_kg_s);
    [state, ~] = docking.stepTruth(state, dt, time, options);
    for index = 1:count
        if strcmp(stateAt(faults, specs(index).id), 'nominal')
            remaining(index) = max(0, remaining(index) - dt);
        end
    end
    time = startTime + tick * dt;
    states(:, tick + 1) = state;
    times(tick + 1) = time;
end
result = struct('id', caseDefinition.id, 'ticks', caseDefinition.ticks, ...
    'time_s', times, 'states', states, 'applications', applications, 'faults', faults);
end

function value = emptyApplication(count)
value = struct('ids', {cell(count, 1)}, 'quantizedOnTime_s', zeros(count, 1), ...
    'activeOnTime_s', zeros(count, 1), 'force_N', zeros(3, 1), ...
    'torque_Nm', zeros(3, 1), 'specificForce_body_mps2', zeros(3, 1), ...
    'specificForce_hill_mps2', zeros(3, 1), 'propellantRate_kg_s', 0, ...
    'propellantUsed_kg', 0, 'exhausted', false);
end

function vector = fieldVector(values, specs)
vector = zeros(numel(specs), 1);
for index = 1:numel(specs)
    if isstruct(values) && isfield(values, specs(index).id), vector(index) = values.(specs(index).id); end
end
end

function value = stateAt(states, id)
value = 'nominal';
if isstruct(states) && isfield(states, id), value = char(states.(id)); end
end
