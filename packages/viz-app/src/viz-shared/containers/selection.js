import { toProps } from '@graphistry/falcor';
import { container } from '@graphistry/falcor-react-redux';
import SelectionComponent from 'viz-shared/components/selection';

let Selection = ({ mask = {}, ...props }) => {
    return (
        <SelectionComponent mask={toProps(mask)} {...props}/>
    );
};

Selection = container({
    renderLoading: true,
    fragment: ({ edge = [], point = [] } = {}) => `{
        mask, type, edge, point, darken
    }`
})(Selection);

export { Selection };
