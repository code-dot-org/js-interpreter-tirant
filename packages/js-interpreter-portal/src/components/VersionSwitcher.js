import React, {Component} from 'react';
import PropTypes from 'prop-types';
import moment from 'moment-mini';
import {
  Tabs,
  Tab,
  LinearProgress,
  List,
  ListItem,
  ListItemText,
  Card,
  CardHeader,
  CardContent,
} from 'material-ui';
import styled from 'styled-components';

import {ClientEvents} from '../constants';
import Connection from '../client/Connection';

const Commit = styled.span`
  span {
    &:last-child {
      float: right;
    }
  }
`;

function CommitText({commit: {sha, summary, time, author, committer}}) {
  time = moment(new Date(time));
  return (
    <Commit>
      <span>{sha.slice(0, 6)}</span> {summary}{' '}
      <span>
        {author} {committer && committer !== author && committer}{' '}
        {time.format('ll')} {time.format('LT')}
      </span>
    </Commit>
  );
}
CommitText.propTypes = {
  commit: PropTypes.shape({
    sha: PropTypes.string.isRequired,
    summary: PropTypes.string.isRequired,
    time: PropTypes.number.isRequired,
    author: PropTypes.string.isRequired,
    committer: PropTypes.string.isRequired,
  }).isRequired,
};

function CommitList({current, commits, onClickCommit}) {
  return (
    <CardContent style={{padding: 0}}>
      <List dense>
        {commits.map(({version, commit}) =>
          <ListItem
            key={commit.sha}
            button
            divider
            disableRipple
            onClick={() => onClickCommit(commit.sha)}
          >
            <ListItemText
              primary={
                <span>
                  {commit.sha === current && <strong>(current)</strong>}{' '}
                  {version}
                </span>
              }
              secondary={<CommitText commit={commit} />}
            />
          </ListItem>
        )}
      </List>
    </CardContent>
  );
}
CommitList.propTypes = {
  commits: PropTypes.array.isRequired,
  current: PropTypes.string.isRequired,
  onClickCommit: PropTypes.func.isRequired,
};

export default class VersionSwitcher extends Component {
  static propTypes = {};

  state = {
    versions: [],
    commits: [],
    upstream: [],
    currentVersion: null,
    lastLog: '',
    updating: false,
    tab: 'tags',
  };

  async componentDidMount() {
    Connection.on(ClientEvents.VERSION_MANAGER_STATE_CHANGE, newState => {
      this.setState(newState);
    });
    await Connection.MasterVersionManager.update();
  }

  selectVersion = sha => {
    Connection.MasterVersionManager.selectVersion(sha);
  };

  changeTab = (event, value) => {
    this.setState({tab: value});
  };

  render() {
    return (
      <Card>
        <CardHeader title="Interpreter Versions" />
        <Tabs value={this.state.tab} onChange={this.changeTab}>
          <Tab value="tags" label="Tags" />
          <Tab value="commits" label="Commits" />
          <Tab value="upstream" label="Upstream" />
        </Tabs>
        {(this.state.lastLog || this.state.updating) &&
          <CardContent>
            {this.state.lastLog &&
              <p>
                {this.state.lastLog}
              </p>}
            {this.state.updating && <LinearProgress />}
          </CardContent>}
        {this.state.tab === 'tags' &&
          <CommitList
            commits={this.state.versions}
            current={this.state.currentVersion.sha}
            onClickCommit={this.selectVersion}
          />}
        {this.state.tab === 'commits' &&
          <CommitList
            commits={this.state.commits}
            current={this.state.currentVersion.sha}
            onClickCommit={this.selectVersion}
          />}
        {this.state.tab === 'upstream' &&
          <CommitList
            commits={this.state.upstream}
            current={this.state.currentVersion.sha}
            onClickCommit={this.selectVersion}
          />}
      </Card>
    );
  }
}
