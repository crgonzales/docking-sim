function [phi, gamma] = cwDiscreteMatrices(meanMotionRadS, dt_s)
%CWDISCRETEMATRICES Discrete CW transition and constant-acceleration input.
if nargin < 2 || ~isscalar(dt_s) || ~isfinite(dt_s) || dt_s <= 0 || ~isscalar(meanMotionRadS) || ~isfinite(meanMotionRadS)
    error('docking:InvalidCwStep', 'mean motion and dt_s must be finite scalars, with dt_s positive.');
end
n = meanMotionRadS;
A = [0 0 0 1 0 0; 0 0 0 0 1 0; 0 0 0 0 0 1; ...
    3*n*n 0 0 0 2*n 0; 0 0 0 -2*n 0 0; 0 0 -n*n 0 0 0];
B = [zeros(3); eye(3)];
% The augmented exponential avoids division by n and cancellation when n*dt
% is small. At n=0 it gives the exact constant-acceleration double integrator.
transition = expm([A B; zeros(3,9)] * dt_s);
phi = transition(1:6,1:6);
gamma = transition(1:6,7:9);
end
