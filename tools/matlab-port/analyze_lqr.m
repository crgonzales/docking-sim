function analysis = analyze_lqr(config, outputDirectory, fixture)
%ANALYZE_LQR Independent ideal full-state CW LQR analysis.
% The discretization here uses an augmented matrix exponential, independent
% of the TypeScript series implementation. This is an unsaturated control
% analysis, not a thruster-limited docking or noisy-navigation experiment.

if nargin < 1 || isempty(config)
    [config, fixture] = docking.loadReference();
elseif nargin < 3 || isempty(fixture)
    [~, fixture] = docking.loadReference();
end
if isfield(config, 'config'), fixture = config; config = fixture.config; end
if nargin < 2 || isempty(outputDirectory)
    packageDirectory = fileparts(mfilename('fullpath'));
    outputDirectory = fullfile(packageDirectory, 'output');
end
if ~isfolder(outputDirectory), mkdir(outputDirectory); end

dt = fixture.lqr.dt_s;
n = config.meanMotionRadS;
A = [0 0 0 1 0 0; 0 0 0 0 1 0; 0 0 0 0 0 1; ...
    3*n*n 0 0 0 2*n 0; 0 0 0 -2*n 0 0; 0 0 -n*n 0 0 0];
B = [zeros(3); eye(3)];
augmented = expm([A B; zeros(3, 9)] * dt);
phi = augmented(1:6, 1:6);
gamma = augmented(1:6, 7:9);
Q = diag(fixture.lqr.qWeights(:));
R = diag(fixture.lqr.rWeights(:));
analysis = struct('status', 'SKIPPED', 'label', ...
    'Unsaturated ideal full-state feedback linear analysis (not a thruster-limited docking demonstration).', ...
    'dt_s', dt, 'meanMotionRadS', n, 'phi', phi, 'gamma', gamma, ...
    'qWeights', fixture.lqr.qWeights(:)', 'rWeights', fixture.lqr.rWeights(:)', ...
    'mass_kg', fixture.lqr.mass_kg, 'message', 'Control System Toolbox (dlqr) not available.');
hasControl = ~isempty(which('dlqr'));
try
    hasControl = hasControl && license('test', 'Control_Toolbox');
catch
    hasControl = false;
end
if ~hasControl
    return;
end

[gain, P, closedLoopEigenvalues] = dlqr(phi, gamma, Q, R);
S = R + gamma' * P * gamma;
fixedPoint = Q + phi' * P * phi - phi' * P * gamma * (S \ (gamma' * P * phi));
residual = norm(fixedPoint - P, 'fro');
initial = [0.05; -0.1; 0.03; 0; 0; 0];
steps = 600;
trajectory = zeros(6, steps + 1);
forceDemand = zeros(3, steps);
trajectory(:, 1) = initial;
for index = 1:steps
    forceDemand(:, index) = -fixture.lqr.mass_kg * gain * trajectory(:, index);
    trajectory(:, index + 1) = (phi - gamma * gain) * trajectory(:, index);
end
analysis.status = 'PASS';
analysis.message = 'dlqr completed.';
analysis.gain_3x6 = gain;
analysis.dareResidual = residual;
analysis.closedLoopEigenvalues = closedLoopEigenvalues;
analysis.trajectory = trajectory;
analysis.forceDemand_N = forceDemand;
analysis.tsGainMaxAbsError = max(abs(gain(:) - fixture.lqr.gain_3x6(:)));
analysis.tsPhiMaxAbsError = max(abs(phi(:) - fixture.lqr.phi(:)));
analysis.tsGammaMaxAbsError = max(abs(gamma(:) - fixture.lqr.gamma(:)));

time = (0:steps) * dt;
figureHandle = figure('Visible', 'off', 'Name', 'CW LQR ideal analysis', ...
    'Color','w','Position',[100 100 1100 700]);
if isprop(figureHandle,'Theme'), figureHandle.Theme='light'; end
closeFigure = onCleanup(@()close(figureHandle)); %#ok<NASGU>
subplot(2, 1, 1);
plot(time, trajectory(1:3, :)'); grid on; xlabel('time (s)'); ylabel('position (m)');
legend('x', 'y', 'z', 'Location', 'best');
title('CW state trajectory - unsaturated ideal full-state feedback');
subplot(2, 1, 2);
forceTime = (0:steps-1) * dt;
plot(forceTime, forceDemand'); grid on; xlabel('time (s)'); ylabel('force demand (N)');
legend('F_x', 'F_y', 'F_z', 'Location', 'best');
exportgraphics(figureHandle, fullfile(outputDirectory, 'lqr-trajectory-force.png'), ...
    'Resolution',140);
end
