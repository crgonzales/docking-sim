function [nextState, derivative] = stepTruth(state, dt_s, t_s, options)
%STEPTRUTH Integrate the 14-element six-DOF truth state by one RK4 step.
% State is [r_hill(3); v_hill(3); q_BI(4); w_body(3); propellant]. Time is
% separate so the numeric state has the stable documented 14x1 shape.

if nargin < 4 || isempty(options), options = struct(); end
state = state(:);
if numel(state) ~= 14 || any(~isfinite(state))
    error('docking:InvalidState', 'state must be a finite 14x1 vector.');
end
if norm(state(7:10)) == 0
    error('docking:InvalidQuaternion', 'state quaternion must be non-zero.');
end
if ~isscalar(dt_s) || ~isfinite(dt_s) || dt_s <= 0
    error('docking:InvalidStep', 'dt_s must be finite and positive.');
end
if ~isscalar(t_s) || ~isfinite(t_s)
    error('docking:InvalidTime', 't_s must be a finite scalar.');
end
n = optionOr(options, 'meanMotionRadS', sqrt(3.986004418e14 / (6.371e6 + 400e3)^3));
inertia = vectorOption(options, 'inertia_kg_m2', [600; 400; 600]);
forceBody = vectorOption(options, 'externalSpecificForce_body_mps2', [0; 0; 0]);
torque = vectorOption(options, 'torque_body_Nm', [0; 0; 0]);
if ~isscalar(n) || ~isfinite(n), error('docking:InvalidMeanMotion', 'mean motion must be finite.'); end
if numel(inertia) ~= 3 || any(~isfinite(inertia)) || any(inertia <= 0)
    error('docking:InvalidInertia', 'inertia_kg_m2 must be finite and positive.');
end
if numel(forceBody) ~= 3 || any(~isfinite(forceBody)) || numel(torque) ~= 3 || any(~isfinite(torque))
    error('docking:InvalidInput', 'force and torque must be finite 3x1 vectors.');
end

k1 = derivativeAt(t_s, state, n, forceBody, torque, inertia);
k2State = state + (dt_s/2) * k1;
k2 = derivativeAt(t_s + dt_s/2, k2State, n, forceBody, torque, inertia);
k3State = state + (dt_s/2) * k2;
k3 = derivativeAt(t_s + dt_s/2, k3State, n, forceBody, torque, inertia);
k4State = state + dt_s * k3;
k4 = derivativeAt(t_s + dt_s, k4State, n, forceBody, torque, inertia);
derivative = (k1 + 2*k2 + 2*k3 + k4) / 6;
nextState = state + dt_s * derivative;
nextState(7:10) = docking.normalizeQuat(nextState(7:10));
propellantRate = optionOr(options, 'propellantRate_kg_s', 0);
if ~isscalar(propellantRate) || ~isfinite(propellantRate)
    error('docking:InvalidPropellantRate', 'propellant rate must be finite.');
end
nextState(14) = max(0, state(14) - max(0, propellantRate) * dt_s);
end

function derivative = derivativeAt(t_s, state, n, forceBody, torque, inertia)
qBI = state(7:10);
qIH = docking.hillFromInertial(t_s, n);
qHB = docking.conjugateQuat(docking.normalizeQuat(docking.multiplyQuat(qBI, qIH)));
forceHill = docking.rotateVector(qHB, forceBody);
r = state(1:3); v = state(4:6); w = state(11:13);
n2 = n*n;
angularMomentum = inertia .* w;
gyroscopicTerm = cross(w, angularMomentum);
qDot = 0.5 * docking.multiplyQuat([0; -w], qBI);
derivative = [v; ...
    3*n2*r(1) + 2*n*v(2) + forceHill(1); ...
    -2*n*v(1) + forceHill(2); ...
    -n2*r(3) + forceHill(3); ...
    qDot; ...
    (torque - gyroscopicTerm) ./ inertia; ...
    0];
end

function value = optionOr(options, name, defaultValue)
if isfield(options, name) && ~isempty(options.(name)), value = options.(name); else, value = defaultValue; end
end

function value = vectorOption(options, name, defaultValue)
value = optionOr(options, name, defaultValue);
value = value(:);
end
