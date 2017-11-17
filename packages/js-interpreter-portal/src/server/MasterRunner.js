import RPCInterface from './RPCInterface';
import SlaveRunner from '../slave/SlaveRunner';

@RPCInterface({ type: 'master' })
export default class MasterRunner {
  static SlaveClass = SlaveRunner;
  latestResults = [];

  getSavedResults = () =>
    this.slaveManager.emitToPrimarySlave('SlaveRunner.getSavedResults');

  getNewResults = () =>
    this.slaveManager.emitToAllSlaves('SlaveRunner.getNewResults');

  saveResults = async () => {
    await this.slaveManager.emitToAllSlaves('SlaveRunner.saveResults');
  };

  getSlaveStates = () =>
    this.slaveManager.emitToAllSlaves('SlaveRunner.getClientState');

  kill = async () => {
    await Promise.all(
      this.slaveManager.slaves.map(this.slaveManager.restartSlave)
    );
  };

  execute = async ({ tests, rerun }) => {
    this.latestResults = [];
    this.slaveManager.slaves.forEach((slave, splitIndex, slaves) => {
      this.slaveManager.getSocketFor(slave).emit(
        'SlaveRunner.execute',
        {
          splitIndex,
          splitInto: slaves.length,
          tests,
          rerun,
        },
        newResults => {
          this.latestResults = [...this.latestResults, ...newResults];
        }
      );
    });
  };
}
