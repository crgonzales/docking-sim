function report=run_matlab_port(outputDirectory)
%RUN_MATLAB_PORT Verify the native port, execute Simulink, and write figures.
% MATLAB + Control System Toolbox + Simulink completes every gate. Missing
% optional products produce PARTIAL, with explicitly SKIPPED checks.
root=fileparts(mfilename('fullpath'));
if nargin<1 || isempty(outputDirectory), outputDirectory=fullfile(root,'output'); end
if ~isfolder(outputDirectory), mkdir(outputDirectory); end
report=verify_matlab_port(outputDirectory); % asserts before advertising success
[cfg,fixtures]=docking.loadReference();
nominal=docking.runPulseCase(fixtures.cases.nominal,cfg);
fault=docking.runPulseCase(fixtures.cases.stuckOpen,cfg);
plotPulseCases(nominal,fault,outputDirectory);
report.artifacts={'pulse-trajectories.png','attitude-and-fuel.png','validation.json'};
if ~isempty(which('dlqr')) && license('test','Control_Toolbox')
    analysis=analyze_lqr(cfg,outputDirectory,fixtures);
    report.lqr=struct('gain',analysis.gain_3x6,'dareResidual',analysis.dareResidual, ...
        'poleReal',real(analysis.closedLoopEigenvalues), ...
        'poleImaginary',imag(analysis.closedLoopEigenvalues));
    report.artifacts{end+1}='lqr-trajectory-force.png';
end
if ~isempty(which('sim')) && license('test','Simulink')
    % Verification saved the runnable model. Simulink diagram printing is
    % unavailable in -nodisplay mode; keep batch runs fully headless.
    report.artifacts{end+1}='dragon_sixdof.slx';
end
save(fullfile(outputDirectory,'native-runs.mat'),'nominal','fault','cfg');
file=fopen(fullfile(outputDirectory,'run-summary.json'),'w');
assert(file>=0,'Could not write run summary');
guard=onCleanup(@()fclose(file)); %#ok<NASGU>
fprintf(file,'%s\n',jsonencode(report,PrettyPrint=true));
fprintf('Artifacts saved to %s\n',outputDirectory);
end
function plotPulseCases(nominal,fault,out)
t=nominal.time_s-nominal.time_s(1);
f=figure('Visible','off','Color','w','Position',[100 100 1100 700]);
if isprop(f,'Theme'), f.Theme='light'; end
cleanup=onCleanup(@()close(f));
tiledlayout(2,2,'TileSpacing','compact');
labels={'Radial x [m]','Along-track y [m]','Cross-track z [m]'};
for k=1:3
    nexttile; plot(t,nominal.states(k,:),'LineWidth',1.3); hold on;
    plot(t,fault.states(k,:),'--','LineWidth',1.3);
    grid on; xlabel('Time since experiment start [s]'); ylabel(labels{k});
end
nexttile; plot3(nominal.states(1,:),nominal.states(2,:),nominal.states(3,:),'LineWidth',1.3);
hold on; plot3(fault.states(1,:),fault.states(2,:),fault.states(3,:),'--','LineWidth',1.3);
grid on; xlabel('x [m]'); ylabel('y [m]'); zlabel('z [m]');
legend('Nominal','J6 stuck open, then isolated','Location','best');
sgtitle('Native six-DOF RCS experiment | Dragon-style simulation parameters');
exportgraphics(f,fullfile(out,'pulse-trajectories.png'),'Resolution',140);
clear cleanup;
f=figure('Visible','off','Color','w','Position',[100 100 1100 700]);
if isprop(f,'Theme'), f.Theme='light'; end
cleanup=onCleanup(@()close(f)); %#ok<NASGU>
tiledlayout(2,2,'TileSpacing','compact');
nexttile; plot(t,nominal.states(7:10,:)','LineWidth',1.2); grid on;
xlabel('Time [s]'); ylabel('q_B_I'); legend('w','x','y','z'); title('Nominal attitude');
nexttile; plot(t,fault.states(7:10,:)','LineWidth',1.2); grid on;
xlabel('Time [s]'); ylabel('q_B_I'); title('Fault-case attitude');
nexttile; plot(t,nominal.states(11:13,:)','LineWidth',1.2); hold on;
plot(t,fault.states(11:13,:)','--','LineWidth',1.2); grid on;
xlabel('Time [s]'); ylabel('Body angular rate [rad/s]'); title('Solid: nominal; dashed: fault');
nexttile; plot(t,nominal.states(14,:),'LineWidth',1.2); hold on;
plot(t,fault.states(14,:),'--','LineWidth',1.2); grid on;
xlabel('Time [s]'); ylabel('Remaining propellant [kg]');
legend('Nominal','Fault'); sgtitle('Attitude, angular rates and propellant');
exportgraphics(f,fullfile(out,'attitude-and-fuel.png'),'Resolution',140);
end
