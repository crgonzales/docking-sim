function application = applyThrusters(command, config)
%APPLYTHRUSTERS Resolve one command window or one 100 Hz pulse slice.
% command is a 16x1 vector in thruster-table order. config is the config
% returned by docking.loadReference (or its .config field).

command = command(:);
specs = config.specs;
count = numel(specs);
if numel(command) ~= count || any(~isfinite(command))
    error('docking:InvalidCommand', 'command must have one finite entry per thruster.');
end
truthHz = optionOr(config, 'truthHz', 100);
window = optionOr(config, 'window_s', 1/truthHz);
minOnTime = optionOr(config, 'minOnTime_s', 0.020);
isp = optionOr(config, 'isp_s', 220);
g0 = optionOr(config, 'g0_mps2', 9.80665);
dryMass = optionOr(config, 'dryMass_kg', 976);
propellant = max(0, optionOr(config, 'prop_kg', optionOr(config, 'initialProp_kg', 24)));
if any(~isfinite([truthHz, window, minOnTime, isp, g0, dryMass])) || ...
        truthHz <= 0 || window <= 0 || minOnTime < 0 || isp <= 0 || g0 <= 0 || dryMass <= 0
    error('docking:InvalidThrusterConfig', 'thruster timing, propulsion, and mass values must be positive.');
end

quantized = zeros(count, 1);
active = zeros(count, 1);
forceImpulse = zeros(3, 1);
torqueImpulse = zeros(3, 1);
requestedPropellant = 0;
for index = 1:count
    spec = specs(index);
    position = spec.position_body_m(:);
    direction = spec.direction_body(:);
    if numel(position) ~= 3 || any(~isfinite(position)) || numel(direction) ~= 3 || any(~isfinite(direction)) || norm(direction) == 0 || ...
            ~isfinite(spec.thrust_N) || spec.thrust_N <= 0
        error('docking:InvalidThruster', 'thruster geometry and thrust must be finite, with a non-zero direction.');
    end
    requested = min(window, max(0, command(index)));
    quantized(index) = quantizeOnTime(requested, truthHz, minOnTime);
    state = stateAt(config, spec.id);
    if strcmp(state, 'stuck_open')
        active(index) = window;
    elseif strcmp(state, 'nominal')
        active(index) = min(window, quantized(index));
    else
        active(index) = 0;
    end
    requestedPropellant = requestedPropellant + spec.thrust_N * active(index) / (isp * g0);
end

scale = 1;
if requestedPropellant > propellant, scale = propellant / requestedPropellant; end
for index = 1:count
    active(index) = active(index) * scale;
    impulse = specs(index).direction_body(:) * specs(index).thrust_N * active(index);
    forceImpulse = forceImpulse + impulse;
    torqueImpulse = torqueImpulse + cross(specs(index).position_body_m(:), impulse);
end
force = forceImpulse / window;
torque = torqueImpulse / window;
mass = dryMass + propellant;
application = struct();
application.ids = {specs.id}';
application.quantizedOnTime_s = quantized;
application.activeOnTime_s = active;
application.force_N = force;
application.torque_Nm = torque;
application.specificForce_body_mps2 = force / mass;
application.specificForce_hill_mps2 = application.specificForce_body_mps2;
application.propellantRate_kg_s = requestedPropellant * scale / window;
application.propellantUsed_kg = requestedPropellant * scale;
application.exhausted = propellant <= 0 || application.propellantUsed_kg >= propellant;
end

function value = quantizeOnTime(requested, truthHz, minimum)
if ~isfinite(requested) || requested <= 0 || requested < minimum, value = 0; return; end
tick = 1 / truthHz;
value = round(requested / tick) * tick;
if value < minimum, value = 0; end
end

function value = optionOr(options, name, defaultValue)
if isfield(options, name) && ~isempty(options.(name)), value = options.(name); else, value = defaultValue; end
end

function value = stateAt(config, id)
value = 'nominal';
if ~isfield(config, 'states') || isempty(config.states), return; end
if isstruct(config.states) && isfield(config.states, id), value = char(config.states.(id)); end
end
